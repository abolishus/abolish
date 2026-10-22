# Account keys

How the operator adds and rotates the keys that keep a verified account's phone number and e-mail address out of a database dump ([[0038-verified-accounts]], Keys; [[P2-31]]). Whoever holds the account tables and every phone-hash key recovers every verified number in minutes, since the number space is small (T-73), so these keys are the only thing standing between a dump and the numbers. This page is the order of steps that keeps that true through a rotation.

## The keyrings

Three, in `apps/web`'s environment only, never in the database, a log, a ticket or a chat:

| Variable          | Holds                                                          | Its values                                  |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `PHONE_HASH_KEYS` | the keys of each number's nested HMAC chain                    | `account_phones` and the other phone tables |
| `EMAIL_HASH_KEYS` | the keys of each address's keyed hash (one account an address) | `account_emails.address_hash`               |
| `EMAIL_BOX_KEYS`  | the keys sealing each address (AES-256-GCM)                    | `account_emails` ciphertext                 |

Each is `id:hex,id:hex,…`, oldest first (`packages/core`, `src/keyring.ts`): an ID of lowercase letters, digits and hyphens, at most 32, and 64 hex digits of key. The last key is current, unless one entry ends in `*`, which makes that one current instead. No key may appear in two keyrings or twice in one; the website refuses to start otherwise, naming the variable and never the value.

Make a key with a CSPRNG on a machine you trust, for example `openssl rand -hex 32`, and give it an ID never used in that keyring before (`p2`, `p3`, …).

## Rules

- **Never drop, reorder or insert a phone-hash key.** Add new keys at the end only, and keep every one for good. A number's chain runs through every key in order; a keyring missing one, or with two swapped, computes a different chain and stops matching every value made under it, which lets that number verify a second account (T-01). Each key is useless without the later ones and the table, so keeping old ones costs nothing.
- **Two deploys for every new key**, in every keyring: first listed but not current, then current. An instance that doesn't hold a key can't match values made under it, so a key made current while some instance still runs without it could let one number, or one address, verify two accounts.
- **Rotate the phone-hash key after any suspected exposure** of the key, the environment, a host or a backup, and otherwise once a year.

## Rotating the phone-hash key

1. **Stage.** Append the new key to `PHONE_HASH_KEYS` and mark the current one with `*`, for example from `p1:<hex>` to `p1:<hex>*,p2:<hex>`. Deploy, and wait until no instance runs the old configuration (Railway's deployment page shows the old one removed).
2. **Make it current.** Remove the `*`: `p1:<hex>,p2:<hex>`. Deploy, and wait as before.
3. **The rotation runs by itself.** Every instance's account timer (`apps/web`, `src/node/prune.ts`, every 10 minutes and at start) extends every stored chain not yet under the current key by one HMAC per later key (`rotatePhoneHashes`): the verified numbers, the holds, the codes waiting and the per-number send counts. The number is never needed. Instances still on the staged configuration leave rows under the new key alone, and two instances rotating at once only repeat each other.
4. **Check it is done**, as the migrator role, at least 10 minutes after step 2's deploy finished:

   ```sql
   SELECT 'account_phones' AS t, hash_key, count(*) FROM account_phones GROUP BY hash_key
   UNION ALL SELECT 'account_phone_holds', hash_key, count(*) FROM account_phone_holds GROUP BY hash_key
   UNION ALL SELECT 'account_phone_codes', hash_key, count(*) FROM account_phone_codes GROUP BY hash_key
   UNION ALL SELECT 'account_phone_recipients', hash_key, count(*) FROM account_phone_recipients GROUP BY hash_key;
   ```

   Every row should show the new key's ID. A per-number count with no key (`NULL`) predates migration 0029 and is pruned within a day; nothing else should remain.

5. **Watch the log** for two lines, by kind only: `PhoneHashRotationFailed` (a run failed; the next tick tries again; if it repeats, look at the database) and `PhoneHashKeyMissing` (some row is under a key this instance's keyring doesn't hold: a key was dropped or mistyped, which must be put back exactly as it was, or an instance runs an old configuration). Neither line names a key or a row.

What it buys: once step 4 shows no old key, a dump of the database taken from then on is useless with the old keys alone (T-73). What it doesn't: a dump or backup taken before it still holds chains under the old keys, so after an exposure, also delete or re-encrypt the backups made before the rotation (T-66, T-69), and run `VACUUM` on the four tables so dead row versions holding the old values are reclaimed. Until vacuumed, old values stay in the table's files and in the write-ahead log the provider keeps for point-in-time recovery.

## The e-mail keyrings

Adding a key to `EMAIL_HASH_KEYS` or `EMAIL_BOX_KEYS` follows the same two deploys. An address is matched under every hash key and opened under the box key its row names, so rows made under older keys keep working. Rewriting them under the new keys, so an old e-mail key can be retired, is not built yet ([[P2-31]] part 3d); until it is, an exposed e-mail key protects every address stored before its replacement no longer, and the only remedy is that job.

## Verify service settings

The bound on guessing a phone code (T-01) rests on the Twilio Verify service keeping its defaults, which nothing reads back: codes of 6 digits or more (the adapter refuses to check shorter ones), a 10-minute lifetime, and 5 checks per verification. Check them in Twilio's console whenever the service is created or changed, and after any change of account owner.
