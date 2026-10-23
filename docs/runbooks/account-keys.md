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

- **Never drop, reorder or insert a phone-hash key.** (E-mail keys differ: an old one leaves its keyring once nothing is stored under it; see The e-mail keyrings.) Add new keys at the end only, and keep every one for good. A number's chain runs through every key in order; a keyring missing one, or with two swapped, computes a different chain and stops matching every value made under it, which lets that number verify a second account (T-01). Each key is useless without the later ones and the table, so keeping old ones costs nothing.
- **Two deploys for every new key**, in every keyring: first listed but not current, then current. An instance that doesn't hold a key can't match values made under it, so a key made current while some instance still runs without it could let one number, or one address, verify two accounts.
- **Never change a key's bytes under its ID, and never roll the variables back past step 1 once step 2 is live.** A rotation is one way: once every chain runs through a key, only those exact bytes match them. The first instance to hold a phone-hash or e-mail key stores a check value for its ID, and an instance whose keys don't all reproduce their checks refuses to start (`PHONE_HASH_KEYS: a key differs …`, `EMAIL_HASH_KEYS or EMAIL_BOX_KEYS: a key differs …`): once rows have rotated, a wrong key matches none of them, so through it every number and address another account holds would verify again (T-01).
- **Rotate the phone-hash key after any suspected exposure** of the key, the environment, a host or a backup, and otherwise once a year.

## Rotating the phone-hash key

1. **Stage.** Append the new key to `PHONE_HASH_KEYS` and mark the current one with `*`, for example from `p1:<hex>` to `p1:<hex>*,p2:<hex>`. Deploy, and wait until no instance runs the old configuration (Railway's deployment page shows the old one removed).
2. **Make it current.** Remove the `*`: `p1:<hex>,p2:<hex>`. Deploy, and wait as before.
3. **The rotation runs by itself.** Every instance's account timer (`apps/web`, `src/node/prune.ts`, every 10 minutes and at start) extends every stored chain not yet under the current key by one HMAC per later key (`rotatePhoneHashes`): the verified numbers, the holds, the codes waiting and the per-number send counts. The number is never needed. Instances still on the staged configuration leave rows under the new key alone, and two instances rotating at once only repeat each other.
4. **Check it is done**, connected as a login role granted `abolish_migrator` (which can't log in itself), at least 10 minutes after step 2's deploy finished:

   ```sql
   SELECT 'account_phones' AS t, hash_key, count(*) FROM account_phones GROUP BY hash_key
   UNION ALL SELECT 'account_phone_holds', hash_key, count(*) FROM account_phone_holds GROUP BY hash_key
   UNION ALL SELECT 'account_phone_codes', hash_key, count(*) FROM account_phone_codes GROUP BY hash_key
   UNION ALL SELECT 'account_phone_recipients', hash_key, count(*) FROM account_phone_recipients GROUP BY hash_key;
   ```

   Every row should show the new key's ID. A per-number count with no key (`NULL`) predates migration 0030 and is pruned within a day; nothing else should remain. A `NULL` count newer than a day means an instance still runs code from before migration 0030: finish that deploy first.

5. **Watch the log** for these lines, by kind only; none names a key or a row:
   - `PhoneHashRotationFailed`: a run failed; the next tick tries again. If it repeats, look at the database.
   - `PhoneHashKeyMismatch`: a key's bytes differ from the ones its ID was first seen with, so nothing is rotated (an instance that started before the check was stored; a new one would refuse to start). Put back the exact key; never "fix" it by giving the new bytes a new ID in the same position. If it was the first instance to see the ID that held the wrong bytes (a mistyped staging deploy, say), the stored check is the wrong one; see Fixing a stored check.
   - `PhoneHashKeyMissing`: some row is under a key this instance's keyring doesn't hold. A key was dropped or its ID mistyped, and must be put back exactly as it was, or this instance runs an old configuration.
   - `PhoneHashConflict`: two accounts hold one number, which only an instance missing a key can have let happen; that number's older row is left unrotated. Find the two rows with the step 4 query's tables and delete one account's `account_phones` row without holding the number, so that account can verify another one; deleting it plainly would hold the number for 90 days through the table's trigger:

     ```sql
     BEGIN;
     SET LOCAL abolish.phone_moving = 'on';
     DELETE FROM account_phones WHERE user_id = '<account>';
     COMMIT;
     ```

     The next tick rotates the other row.

What it buys: once step 4 shows no old key, a dump of the database taken from then on is useless with the old keys alone (T-73). What it doesn't: a dump or backup taken before it still holds chains under the old keys, so after an exposure, also delete or re-encrypt the backups made before the rotation (T-66, T-69), and run `VACUUM FULL` on the four tables, which rewrites them and their indexes; plain `VACUUM` only marks dead row versions reusable and leaves their bytes on disk. Even `VACUUM FULL` doesn't reach the write-ahead log the provider keeps for point-in-time recovery, replicas, or disk blocks already freed: shorten the provider's recovery window, or wait it out, before treating the old key as harmless.

## Fixing a stored check

Each key's check value (`account_phone_key_checks`, `account_email_key_checks`) is written by the first instance to hold its ID, and the app can't change it. If that instance held wrong bytes, every correct instance reports a mismatch and nothing rotates. First fix or stop the instance holding the wrong bytes, or it stores its check again on its next tick. Then look at the step 4 query (or the e-mail one below): if no row is under that key ID, nothing was made with the wrong bytes, and a login role granted `abolish_migrator` can delete the check (`DELETE FROM account_phone_key_checks WHERE key_id = '<id>'`, or from `account_email_key_checks` with its `keyring`) so the next tick stores the right one. If rows are under it, they were made with the wrong bytes: put those bytes back under that ID, let a rotation move every row to a new key, and only then retire the ID. Never give one ID two sets of bytes.

## The e-mail keyrings

`EMAIL_HASH_KEYS` (each address's hash, and each waiting code's hash) and `EMAIL_BOX_KEYS` (each address sealed) take new keys by the same two deploys. Unlike a number, an address can be read back, so the timer rewrites every verified address under the current keys, re-hashed and re-sealed, and re-seals every waiting code's address (`rotateEmailKeys`); a row under a key listed after the current one, made by an instance already on the next configuration, is left alone. Then an old key can leave its keyring, and a dump taken from then on is useless with it.

1. **Stage** and **make current**, as steps 1 and 2 above, in either keyring or both.
2. **Check it is done**, at least 10 minutes after the second deploy:

   ```sql
   SELECT 'account_emails' AS t, hash_key, box_key, count(*) FROM account_emails GROUP BY hash_key, box_key
   UNION ALL SELECT 'account_email_codes', code_key, box_key, count(*) FROM account_email_codes GROUP BY code_key, box_key
   UNION ALL SELECT 'account_email_holds', hash_key, NULL, count(*) FROM account_email_holds GROUP BY hash_key;
   ```

   Every verified address should show the current keys. A waiting code keeps its code's hash under the hash key it was made with (the code itself isn't kept) and is gone 15 minutes later, after the next prune. A hold on an address an account let go keeps its hash under the key it was made with for its 90 days, since nothing keeps the address to re-hash it. To find the rows still under older keys, by account:

   ```sql
   SELECT 'account_emails' AS t, user_id FROM account_emails WHERE hash_key <> '<current hash ID>' OR box_key <> '<current box ID>'
   UNION ALL SELECT 'account_email_codes', user_id FROM account_email_codes WHERE box_key <> '<current box ID>';
   ```

3. **Retire the old key** once nothing shows it. An old box key goes once no verified address or waiting code is under it. An old hash key goes no sooner than 91 days after the second deploy has fully rolled out, once its holds have ended and the next prune has deleted them: a hold can't be rewritten, so a hash key dropped sooner frees every address held under it at once, and each could verify another account (T-01). The per-address send counts are hashed under it too and don't record their key; they age out within the day. Remove it from the keyring and deploy. An instance that still meets a row under a removed key fails to open or match it: put the key back.
4. **Watch the log**: `EmailKeyRotationFailed` (the next tick tries again), `EmailKeyMismatch` (as `PhoneHashKeyMismatch`), `EmailKeyMissing` (a row under a key this instance lacks: a key retired too early, or an old configuration) and `EmailKeyRotationSkipped` (a verified address or waiting code whose box didn't open under its key, or an address two accounts hold, left as it is: find it with the query in step 2, and settle it by deleting the unrotated `account_emails` or `account_email_codes` row without holding the address, so that account can verify it again; deleting an `account_emails` row plainly would hold the address for 90 days through the table's trigger:

   ```sql
   BEGIN;
   SET LOCAL abolish.email_unheld = 'on';
   DELETE FROM account_emails WHERE user_id = '<account>';
   COMMIT;
   ```

   For an address two accounts hold, delete the unrotated row the same way; the other account keeps the address. Either way the address is then free to any account that verifies it first, not only the one settled).

After an exposure, the same limits as the phone hash apply: older backups, dead row versions until `VACUUM FULL` on `account_emails`, `account_email_codes` and `account_email_recipients`, and the provider's recovery log. An exposed box key opens every address sealed under it in those; an exposed hash key lets a guessed address be confirmed, and, in the live `account_email_holds` too, for up to 90 days after the rotation, since a hold stays under its key until it ends.

## The web push key

`VAPID_SECRET_KEY` signs every push our server sends (RFC 8292; [[T-76]]), and `VAPID_SUBJECT` is the contact the push services may reach us at (`mailto:` an address we read, or an `https` page). Both live in `apps/web`'s environment only, set only with the e-mail service (the website refuses to start otherwise), and without them `/push` answers 503 and the account page offers no push.

Make the key on a machine you trust: 32 random bytes as unpadded base64url, `openssl rand 32 | basenc --base64url | tr -d =` (the website refuses to start on anything that isn't a P-256 secret key, naming the variable and never the value). It is not one of the keyrings above: it hashes and seals nothing stored, so it has one value, not a list.

A browser subscribes under one public key, and its push service refuses a push signed by any other, so a new key ends every subscription at once:

1. **Set the new key** and deploy. Each push to an old subscription is refused from then on (counted as `AccountPushRefused` in the log), until its account unsubscribes or subscribes five newer browsers; an e-mail still goes with every notice.
2. **Each browser subscribes again** when its account next opens the account page: the switch shows a subscription under the old key as off, and turning it on deletes that one's row and ends it with its push service before subscribing anew. Nothing does this unasked, and nothing tells the account its push stopped: say so wherever the rotation is announced.
3. **Clear the old subscriptions** that now only fail (those whose accounts haven't come back), a day after the deploy, as the app owner: `DELETE FROM account_push_subscriptions WHERE created_at < '<deploy time>';` Their accounts lose nothing but the wake that no longer worked.

Rotate it after any suspected exposure of the environment or a host: whoever holds the key can wake our subscribers' browsers, though only to show our own fixed notice, since our service worker shows nothing else.

## Verify service settings

The bound on guessing a phone code (T-01) rests on the Twilio Verify service keeping its defaults, which nothing reads back: codes of 6 digits or more (the adapter refuses to check shorter ones), a 10-minute lifetime, and 5 checks per verification. Check them in Twilio's console whenever the service is created or changed, and after any change of account owner.
