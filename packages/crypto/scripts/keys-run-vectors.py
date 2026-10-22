#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/keys-run.json.

A second implementation of docs/spec/verifier.md (Token keys across
releases): the keys run over a release registry's proven words, a pool of
release records and a pool of deployment records, giving the run's result
and its report's `releases`, `periods` and `findings`. Standard library only;
it shares no code with packages/crypto or packages/verifier.

It reuses only this folder's other independent generators:
release-registry-vectors.py's namespace, slots and times words (and its
Keccak-256, contract-event-vectors.py's), release-record-vectors.py's release
record (encoding, strict decoder, well-formedness, release hash) and
deployment-record-vectors.py's and deployment-record-v2-vectors.py's
deployment record (encoding, strict decoder of both versions,
well-formedness, deployment hash, the rules across releases and the test
token keys).

Reading the registry's account and words from an L1 header and trie nodes is
Anchors from L1's walk, which l1-anchor.json covers; these vectors give the
words as proven, keyed by slot, as release-registry.json does.

Usage: python3 -I -B packages/crypto/scripts/keys-run-vectors.py <vectors-dir>
(reads site-directory.json from it and writes keys-run.json beside it), then
`vp check --fix`.
"""

import copy
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


reg = _load("release_registry_vectors", "release-registry-vectors.py")
rr = reg.rr
v2 = _load("deployment_record_v2_vectors", "deployment-record-v2-vectors.py")
v1 = v2.v1
h, word = rr.h, reg.word

P = v2.TOKEN_KEY_PERIOD
Q = v2.Q
MASK64 = reg.MASK64
MAX_FINDINGS = 1000


def start(q):
    return q * P


# --- The keys run (verifier.md, Token keys across releases) -----------------


def decode_release(enc):
    try:
        return rr.decode(enc), None
    except rr.DecodeError as e:
        return None, e.args[0]


def decode_deployment(enc):
    try:
        return v2.decode(enc), None
    except v2.DecodeError as e:
        return None, e.args[0]


def deployment_rule(version, d):
    return v1.ill_formed(d) if version == 1 else v2.ill_formed(d)


def judge(v, records, deployments):
    """The run's result and report members for one vector."""
    words = {int(k, 16): bytes.fromhex(w) for k, w in v["storage"].items()}

    def read(slot):
        return int.from_bytes(words.get(slot, bytes(32)), "big")

    now, run_at = int(v["now"]), int(v["runAt"])

    def stop(status, code, at):
        return {"result": {"status": status, "code": code, "at": at}}

    # Step 1.
    if run_at < now or run_at - now > reg.MAX_STALENESS:
        return stop("unverifiable", "l1-stale", {})
    # Step 3 (step 2, the account, is the trie walk's).
    c = read(reg.COUNT_SLOT)
    if c >> 64:
        return stop("fail", "release-registry-state", {"slot": "count"})
    if c == 0:
        return stop("unverifiable", "release-none", {})
    published = []
    for s in range(c):
        rh = read(reg.hash_slot(s))
        t = read(reg.times_slot(s))
        p, r = t & MASK64, t >> 64 & MASK64
        if rh == 0 or t >> 128 or p == 0 or p > now or (r and (r < p or r > now)):
            return stop("fail", "release-registry-state", {"sequence": str(s)})
        published.append((word(rh), p, r))

    # Step 4.
    rows, failing, unsettled, deps = [], [], [], {}
    for s, (rh, p, r) in enumerate(published):
        row = {"sequence": str(s), "hash": h(rh), "publishedAt": str(p)}
        if r:
            row["revokedAt"] = str(r)
        rows.append(row)
        S = {"sequence": str(s)}

        def settle(code, at, final):
            row["outcome"] = code
            (failing if final else unsettled).append((code, at))

        enc = next((e for e in records if rr.release_hash(e) == rh), None)
        if enc is None:
            settle("release-record-missing", S, False)
            continue
        record, err = decode_release(enc)
        if err == "unknown-version":
            settle("unsupported-version", {**S, "record": "release"}, False)
            continue
        if err is not None:
            settle("release-record", {**S, "decodeError": err}, True)
            continue
        bad = rr.ill_formed(record)
        if bad:
            rule, at = bad
            settle("release-record", {**S, "rule": rule, **{k: str(x) for k, x in at.items()}}, True)
            continue
        previous = published[s - 1][0] if s else bytes(32)
        if (
            record["l1_chain_id"] != rr.SEPOLIA
            or record["registry"] != rr.REGISTRY
            or record["sequence"] != s
            or record["previous"] != previous
        ):
            settle("release-chain", S, True)
            continue
        dh = record["deployment_hash"]
        row["deploymentHash"] = h(dh)
        denc = next((e for e in deployments if v1.deployment_hash(e) == dh), None)
        if denc is None:
            settle("deployment-record-missing", S, False)
            continue
        decoded, err = decode_deployment(denc)
        if err == "unknown-version":
            settle("unsupported-version", {**S, "record": "deployment"}, False)
            continue
        if err is not None:
            settle("deployment-record", {**S, "decodeError": err}, True)
            continue
        version, d = decoded
        row["version"] = str(version)
        bad = deployment_rule(version, d)
        if bad:
            rule, at = bad
            settle("deployment-record", {**S, "rule": rule, **{k: str(x) for k, x in at.items()}}, True)
            continue
        row["outcome"] = "resolved"
        deps[s] = (version, d, dh)

    unresolved = [s for s in range(c) if s not in deps]
    listing = sorted(s for s, (version, _, _) in deps.items() if version == 2)

    # Step 5.
    findings = []
    for j in listing:
        for i in listing:
            if i >= j or deps[i][2] == deps[j][2]:
                continue
            got = v2.across(deps[i][1], deps[j][1])
            if got:
                findings.append({"code": got[0], "at": {"earlier": str(i), "later": str(j), "period": str(got[1]["period"])}})

    # Step 6.
    first, retired_from = {}, {}
    for s in listing:
        for k in deps[s][1]["tier0_token_keys"]:
            first.setdefault(k["period"], (s, k))
            if k["retired"]:
                retired_from.setdefault(k["period"], s)
    floor0 = published[listing[0]][1] // P if listing else None
    periods = []
    for q in sorted(first):
        s, k = first[q]
        row = {"period": str(q), "key": h(k["key"]), "firstListed": str(s)}
        if q in retired_from:
            row["retiredFrom"] = str(retired_from[q])
        periods.append(row)
        late = published[s][1] >= P * q and q > floor0 and not k["retired"]
        if late and not any(r < s for r in unresolved):
            findings.append({"code": "token-key-late", "at": {"sequence": str(s), "period": str(q)}})

    # Step 7.
    if failing:
        code, at = failing[0]
        result = {"status": "fail", "code": code, "at": at}
    elif findings:
        result = {"status": "fail", **findings[0]}
    elif unsettled:
        code, at = unsettled[0]
        result = {"status": "unverifiable", "code": code, "at": at}
    else:
        result = {"status": "pass"}
    out = {"result": result, "releases": rows, "periods": periods, "findings": findings[:MAX_FINDINGS]}
    if len(findings) > MAX_FINDINGS:
        out["findingsTruncated"] = True
    return out


# --- Vectors ------------------------------------------------------------------


def main():
    vectors_dir = pathlib.Path(sys.argv[1])
    site_vectors = json.loads((vectors_dir / "site-directory.json").read_text())["vectors"]
    rr.check_sites(site_vectors)

    ballot_like = rr.site_from(site_vectors, "ballot-like", 1, (), True, [])
    by_path = {f["path"]: f["sha256"] for f in ballot_like["files"]}
    v1_base = v1.typical(by_path[b"assets/semaphore-32-0123.zkey"], by_path[b"assets/worker-77b0.js"])
    only_csp = [("content-security-policy", "default-src 'none'; frame-ancestors 'none'")]
    site = rr.site_from(site_vectors, "index-only", 1, ("https://ballot-staging.up.railway.app",), False, only_csp)

    def keys(lo, hi, **changes):
        """Token keys for periods lo to hi; `changes` maps a period to a key label or 'retired'."""
        out = []
        for q in range(lo, hi + 1):
            c = changes.get(f"q{q - Q}".replace("-", "m"))
            label = None if c in (None, "retired") else c
            out.append(v2.token_key(q, label, c == "retired"))
        return out

    def dv2(ks, label=None):
        d = v2.with_keys(v1_base, ks)
        if label:
            # Another deployment with the same keys: a record whose hash differs.
            d["l2_from_block"] += 1 + sum(label.encode())
        return d

    def enc_dep(version, d):
        return v2.encode(d, version=version)

    # Releases' deployments, by name: (version, record) or raw bytes.
    D = {
        "v1": enc_dep(1, v1_base),
        "first": enc_dep(2, dv2(keys(Q - 1, Q + 6))),
        "second": enc_dep(2, dv2(keys(Q, Q + 7))),
        "second-changed": enc_dep(2, dv2(keys(Q, Q + 7, q3="replacement"))),
        # Q + 7, which the first doesn't list, under the first's key of Q - 1.
        "second-reused": enc_dep(2, dv2(keys(Q, Q + 6) + [dict(v2.token_key(Q - 1), period=Q + 7)])),
        "first-retired": enc_dep(2, dv2(keys(Q - 1, Q + 6, q2="retired"))),
        "second-retired": enc_dep(2, dv2(keys(Q, Q + 7, q2="retired"))),
        "late": enc_dep(2, dv2(keys(Q + 8, Q + 15))),
        "late-retired": enc_dep(2, dv2(keys(Q + 8, Q + 15, q8="retired"))),
        "far-back": enc_dep(2, dv2(keys(Q - 4, Q + 3))),
        "same-keys": enc_dep(2, dv2(keys(Q - 1, Q + 6), "same keys")),
        "two-findings": enc_dep(2, dv2(keys(Q + 8, Q + 15, q9="replacement"))),
        "ill-formed-v2": enc_dep(2, dv2([])),
        "ill-formed-key": enc_dep(2, dv2([dict(k, key=bytes(32)) if k["period"] == Q + 2 else k for k in keys(Q - 1, Q + 6)])),
        "ill-formed-v1": None,
        "truncated": enc_dep(2, dv2(keys(Q, Q + 7)))[:-1],
        "version-3": None,
    }
    bad_panel = copy.deepcopy(v1_base)
    case = next(c for c in v1.ill_formed_cases(v1_base) if c[3] is not None and "panel" in c[4])
    case[2](bad_panel)
    assert v1.ill_formed(bad_panel)[1].get("panel") is not None
    D["ill-formed-v1"] = enc_dep(1, bad_panel)
    D["version-3"] = D["second"][:2] + b"\x03" + D["second"][3:]
    for name, enc in D.items():
        assert isinstance(enc, bytes), name

    def record(s, previous, dep, label, /, **override):
        r = rr.base([site], s, previous, label)
        r["deployment_hash"] = v1.deployment_hash(dep) if isinstance(dep, bytes) else dep
        r.update(override)
        return rr.encode(rr.strip(r))

    NOW = start(Q + 8) + 50_000
    T0, T1, T2, T3 = start(Q - 2) + 1_000, start(Q) + 10_000, start(Q + 1) + 10_000, start(Q + 8) + 20_000

    record_pool, deployment_pool = {}, {}

    def scenario(vid, description, releases, *, omit_records=(), omit_deployments=(), extra_records=(), extra_deployments=(), storage=None, now=NOW, run_at=None, count=None):
        """`releases`: (deployment name, published_at, revoked_at, record override or None) in sequence order."""
        hashes, store = [], {}
        recs, deps = list(extra_records), list(extra_deployments)
        previous = bytes(32)
        for s, (dep, p, r, override) in enumerate(releases):
            dbytes = D[dep] if dep is not None else None
            label = f"{vid} {s}"
            if override == "raw-version-2":
                enc = record(s, previous, dbytes, label)
                enc = enc[:2] + b"\x02" + enc[3:]
            elif override == "truncated":
                enc = record(s, previous, dbytes, label)[:-1]
            elif isinstance(override, dict):
                o = {k: (x(previous) if callable(x) else x) for k, x in override.items()}
                enc = record(s, previous, dbytes, label, **o)
            else:
                enc = record(s, previous, dbytes, label)
            rh = rr.release_hash(enc)
            hashes.append(rh)
            if s not in omit_records:
                recs.append(enc)
            if dbytes is not None and s not in omit_deployments and dbytes not in deps:
                deps.append(dbytes)
            store[h(word(reg.hash_slot(s)))] = h(rh)
            store[h(word(reg.times_slot(s)))] = h(reg.times_word(p, r))
            previous = rh
        store[h(word(reg.COUNT_SLOT))] = h(word(len(releases) if count is None else count))
        if storage:
            store = storage(store)
        # A zero word is never stored: the trie proves its slot absent.
        store = {k: x for k, x in store.items() if int(x, 16)}
        v = {
            "id": vid,
            "description": description,
            "storage": dict(sorted(store.items())),
            "records": [],
            "deployments": [],
            "now": str(now),
            "runAt": str(now + 600 if run_at is None else run_at),
        }
        for e in recs:
            record_pool.setdefault(h(e), f"r{len(record_pool)}")
            v["records"].append(record_pool[h(e)])
        for e in deps:
            deployment_pool.setdefault(h(e), f"d{len(deployment_pool)}")
            v["deployments"].append(deployment_pool[h(e)])
        v["expect"] = judge(v, recs, deps)
        out.append(v)
        return v

    out = []
    honest = [("v1", T0, 0, None), ("first", T1, 0, None), ("second", T2, 0, None)]

    def expect(v, status, code=None):
        got = v["expect"]["result"]
        assert got["status"] == status and got.get("code") == code, (v["id"], got)

    expect(scenario("honest", "A version-1 release, then two version-2 releases each listing the periods ahead before they begin", honest), "pass")
    expect(scenario("revoked", "The honest history with the first version-2 release revoked: a revoked release is judged like the others", [honest[0], ("first", T1, T2 + 5, None), honest[2]]), "pass")
    expect(scenario("only-v1", "One release, whose deployment is version 1: nothing to compare", [honest[0]]), "pass")
    expect(scenario("first-v2-floor", "The first version-2 release lists four periods before its own: none is late", [("far-back", T1, 0, None)]), "pass")
    expect(scenario("same-deployment", "Two releases naming one deployment record: the pair is one record judged against itself", [("first", T1, 0, None), ("first", T2, 0, None)]), "pass")
    expect(scenario("same-keys", "Two deployments with the same keys", [("first", T1, 0, None), ("same-keys", T2, 0, None)]), "pass")
    expect(
        scenario(
            "ignored",
            "The honest history with a record the registry doesn't hold and a deployment no release names: both are ignored",
            honest,
            extra_records=[record(0, bytes(32), D["second"], "stray")],
            extra_deployments=[D["late"]],
        ),
        "pass",
    )
    expect(scenario("changed", "The second version-2 release lists another key for Q + 3", [honest[0], honest[1], ("second-changed", T2, 0, None)]), "fail", "token-key-changed")
    expect(scenario("reused", "The second version-2 release lists the first's key of Q - 1 for Q + 7", [honest[0], honest[1], ("second-reused", T2, 0, None)]), "fail", "token-key-reused")
    expect(scenario("unretired", "The first version-2 release retires Q + 2 and the second lists it live", [honest[0], ("first-retired", T1, 0, None), ("second", T2, 0, None)]), "fail", "token-key-unretired")
    expect(scenario("retired-kept", "Both version-2 releases retire Q + 2", [honest[0], ("first-retired", T1, 0, None), ("second-retired", T2, 0, None)]), "pass")
    expect(scenario("late", "A release published in Q + 8 is the first to list Q + 8", honest + [("late", T3, 0, None)]), "fail", "token-key-late")
    expect(scenario("late-retired", "A release published in Q + 8 is the first to list Q + 8, retired: its key never issues", honest + [("late-retired", T3, 0, None)]), "pass")
    expect(
        scenario("late-and-changed", "A late release, then one listing another key for Q + 9: both findings are listed, step 5's first", honest + [("late", T3, 0, None), ("two-findings", T3 + 10, 0, None)]),
        "fail",
        "token-key-changed",
    )
    expect(
        scenario(
            "late-behind-missing",
            "A late listing above a release whose deployment record isn't given: no finding while it might list the period first",
            honest + [("late", T3, 0, None)],
            omit_deployments=(2,),
        ),
        "unverifiable",
        "deployment-record-missing",
    )
    expect(
        scenario("late-above-missing", "A late listing below a release whose record isn't given: the finding stands", honest + [("late", T3, 0, None), ("second", T3 + 10, 0, None)], omit_records=(4,)),
        "fail",
        "token-key-late",
    )
    expect(
        scenario(
            "late-behind-ill-formed",
            "A late listing above a release whose deployment is ill formed: that release fails the run, and the late listing is no finding",
            [honest[0], honest[1], ("ill-formed-v2", T2, 0, None), ("late", T3, 0, None)],
        ),
        "fail",
        "deployment-record",
    )
    expect(scenario("record-missing", "The first version-2 release's record isn't given", honest, omit_records=(1,)), "unverifiable", "release-record-missing")
    expect(scenario("deployment-missing", "The second version-2 release's deployment record isn't given", honest, omit_deployments=(2,)), "unverifiable", "deployment-record-missing")
    expect(scenario("release-unsupported", "A release record of version 2, which this release doesn't read", [honest[0], ("first", T1, 0, "raw-version-2")]), "unverifiable", "unsupported-version")
    expect(scenario("deployment-unsupported", "A deployment record of version 3, which this release doesn't read", [honest[0], ("version-3", T1, 0, None)]), "unverifiable", "unsupported-version")
    expect(
        scenario("unsupported-then-fail", "An unsupported deployment, then a changed key: the failure decides", [("first", T1, 0, None), ("version-3", T2, 0, None), ("second-changed", T2 + 10, 0, None)]),
        "fail",
        "token-key-changed",
    )
    expect(scenario("release-truncated", "A release record cut short", [honest[0], ("first", T1, 0, "truncated")]), "fail", "release-record")
    expect(
        scenario("release-ill-formed", "A release record with a non-zero previous at sequence 0", [("first", T1, 0, {"previous": rr.sha256(b"not zero")})]),
        "fail",
        "release-record",
    )
    expect(
        scenario("release-site-rule", "A release record whose site lists an origin that isn't one", [("first", T1, 0, {"sites": [dict(site, origins=[b"http://ballot.example"])]})]),
        "fail",
        "release-record",
    )
    for vid, what, o in [
        ("chain-id", "another L1 chain ID", {"l1_chain_id": 1}),
        ("chain-registry", "another registry", {"registry": rr.sha256(b"another registry")[:20]}),
        ("chain-sequence", "another sequence", {"sequence": 7}),
    ]:
        expect(scenario(vid, f"A release record that names {what}", [honest[0], ("first", T1, 0, o)]), "fail", "release-chain")
    expect(
        scenario(
            "chain-previous",
            "A release record whose previous isn't the hash at the sequence before",
            [honest[0], ("first", T1, 0, {"previous": lambda prev: rr.sha256(b"not the previous")})],
        ),
        "fail",
        "release-chain",
    )
    expect(scenario("deployment-truncated", "A deployment record cut short", [honest[0], ("truncated", T1, 0, None)]), "fail", "deployment-record")
    expect(scenario("deployment-no-keys", "A version-2 deployment record with no token key", [("ill-formed-v2", T1, 0, None)]), "fail", "deployment-record")
    expect(scenario("deployment-bad-key", "A version-2 deployment record whose key of Q + 2 is the identity", [("ill-formed-key", T1, 0, None)]), "fail", "deployment-record")
    expect(scenario("deployment-v1-rule", "A version-1 deployment record that breaks a panel's rule", [("ill-formed-v1", T0, 0, None)]), "fail", "deployment-record")
    expect(
        scenario("missing-then-ill-formed", "A missing record, then an ill-formed deployment: the failure decides", [("first", T1, 0, None), ("second", T2, 0, None), ("ill-formed-v2", T3, 0, None)], omit_records=(1,)),
        "fail",
        "deployment-record",
    )

    # Steps 1 to 3.
    expect(scenario("stale", "A header more than an hour before the run's clock", honest, run_at=NOW + reg.MAX_STALENESS + 1), "unverifiable", "l1-stale")
    expect(scenario("fresh-at-limit", "A header exactly an hour before the run's clock", honest, run_at=NOW + reg.MAX_STALENESS), "pass")
    expect(scenario("future", "A header after the run's clock", honest, run_at=NOW - 1), "unverifiable", "l1-stale")
    expect(scenario("none", "No release published", [], count=0), "unverifiable", "release-none")
    expect(scenario("count-high", "A count with a bit above 64 set", honest, count=3 | 1 << 64), "fail", "release-registry-state")
    expect(scenario("count-past", "A count past the releases written: sequence 3's hash is zero", honest, count=4), "fail", "release-registry-state")

    def set_times(s, t):
        return lambda store: {**store, h(word(reg.times_slot(s))): h(word(t))}

    for vid, what, t in [
        ("times-high", "a bit above 128 set", T1 | 1 << 128),
        ("times-unpublished", "no publication time", 0),
        ("times-future", "a publication after the header", NOW + 1),
        ("revoked-before", "a revocation before the publication", T1 | (T1 - 1) << 64),
        ("revoked-future", "a revocation after the header", T1 | (NOW + 1) << 64),
    ]:
        expect(scenario(vid, f"Sequence 1's times word with {what}", honest, storage=set_times(1, t)), "fail", "release-registry-state")
    expect(scenario("revoked-at-publication", "A release revoked in the block that published it", [honest[0], ("first", T1, T1, None), honest[2]]), "pass")
    expect(scenario("published-at-now", "A release published in the header's own block", honest[:2] + [("same-keys", NOW, 0, None)]), "pass")

    zero_hash = lambda store: {k: x for k, x in store.items() if k != h(word(reg.hash_slot(1)))}  # noqa: E731
    expect(scenario("hash-zero", "Sequence 1's hash is zero", honest, storage=zero_hash), "fail", "release-registry-state")

    codes = sorted({v["expect"]["result"].get("code") for v in out} - {None})
    want = {
        "l1-stale", "release-none", "release-registry-state", "release-record-missing", "release-record", "release-chain",
        "unsupported-version", "deployment-record-missing", "deployment-record", "token-key-changed", "token-key-reused",
        "token-key-unretired", "token-key-late",
    }
    assert set(codes) == want, set(codes) ^ want
    assert len({v["id"] for v in out}) == len(out)

    doc = {
        "format": "abolish-keys-run-vectors/1",
        "title": "The keys run: Tier 0 token keys across every published release, judged from the release registry's proven words",
        "spec": "docs/spec/verifier.md (Token keys across releases)",
        "generator": (
            "packages/crypto/scripts/keys-run-vectors.py: standard library only; reuses release-registry-vectors.py's slots, "
            "release-record-vectors.py's release record and deployment-record-v2-vectors.py's deployment record"
        ),
        "pins": {"l1ChainId": str(rr.SEPOLIA), "registry": h(rr.REGISTRY)},
        "tokenKeyPeriod": str(P),
        "maxL1Staleness": str(reg.MAX_STALENESS),
        "maxFindings": str(MAX_FINDINGS),
        "records": {n: k for k, n in record_pool.items()},
        "deployments": {n: k for k, n in deployment_pool.items()},
        "vectors": out,
    }
    (vectors_dir / "keys-run.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
