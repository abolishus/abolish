# Intake relay

How staging runs `apps/intake-relay`, the relay a ballot client sends sealed deliveries through to a seat's node ([[sealed-delivery]], The relay; [[0043-intake-anonymiser]]; [[P2-8]] part 3c-1b-2b-2b-2d-2b-2e-5). The relay sees each client's address beside the seat and election it delivers to, never the ballot (T-13); whoever runs it and the operator together recover what it hides, so staging's relay, on the operator's own Railway project, hides nothing from the operator ([[0043-intake-anonymiser]], Consequences). Production's relays are the owner's to choose and wait on them.

Status: not deployable yet. The deploy workflow doesn't build or deploy its image, and the ballot client's `connect-src` doesn't list its origin, both a `ci:` change (part 2e-5b); and staging's seats serve no intake endpoint ([[trustee-node]], Staging on Railway: No inbound), so it has no node to reach until they do.

## Service

- **One Railway service, `intake-relay`**, from the relay's image, with a public domain (its origin is what the deployment record lists, [[deployment]], `relay`) and no volume: it keeps no state. Any number of replicas; each limits rates on its own.
- **Its own origin**, never the API's, the website's or an RPC's: the record refuses a relay at an endpoint's origin (`relay-endpoint`), and one under `backup_rp_id` (`relay-rp`).
- **`RELAY_CONFIG`** (`apps/intake-relay`, README, Configuration): `host` `0.0.0.0`, `port` the service's target port, and one resource per seat, `{ "path": "seat-<i>", "node": "https://seat-<i>.railway.internal:<port>", "ca": "<the seat's certificate>" }`, over the private network. Set `rate` with `addressHeader` set to the header Railway's edge puts the client's address in, and check on deploy day that a client can't set its last value: otherwise every client is limited as the edge's address, or spoofs another's.
- **Logs** hold a count per resource each minute and nothing else. Railway's own edge logs requests with the client's address (T-11, the platform's logs are a residual, as for the API): turn off what the project can, and treat the rest as part of staging's relaxation.

## Deploy and roll back

As every image: built, signed and deployed by digest from the deploy workflow, rolled back by redeploying the previous digest ([[railway]], Deploying). A rollback loses nothing: the relay holds nothing between requests, and a client retries a failed attempt by its other routes ([[sealed-delivery]], Client rules, rule 6).

## Rotate

There is no secret. A seat's certificate changing is a `ca` change in `RELAY_CONFIG` and a redeploy; until then the relay answers 502 for that seat, which costs it its sealed route and nothing more (T-25).

## Seat moves, relay seized

- **A seat's node moves:** change its resource's `node` (and `ca`); the path, and so the release, stays the same ([[0043-intake-anonymiser]], Consequences).
- **The relay's host or domain is lost:** clients of releases that list it fall back to the operator's route and posting ([[delivery]], Client rule 4). A new origin needs a new release whose record lists it, and the ballot client's `connect-src` with it. Nothing to restore: no state.
