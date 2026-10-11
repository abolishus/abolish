---
"@abolishus/verifier": minor
---

Adds `runCli` and `EXIT_CODES`: the `abolish-verify` command line over one local bundle (`docs/spec/verifier.md`, Command line). It prints the JSON report on stdout and a summary on stderr, and exits 0 verified, 3 failed, 4 unverifiable, 5 bundle rejected or 2 usage, on `verdict` alone. The package doesn't install an `abolish-verify` binary yet. Nothing existing changes.
