# Auto-updates

FatClipboard checks for a newer version on every startup (see the `.setup()`
block near the top of `src-tauri/src/main.rs`), and if one's available,
silently downloads it, verifies its signature, installs it, and relaunches
into the new version. No "check for updates" button needed, and users never
have to manually redownload the installer again.

## How it works

- `tauri-plugin-updater` polls the URL(s) in `src-tauri/tauri.conf.json`'s
  `plugins.updater.endpoints` -- currently pointed at this repo's GitHub
  Releases (`.../releases/latest/download/latest.json`).
- That `latest.json` is a small manifest (version, release notes URL,
  per-platform download URL + signature) that the release workflow below
  generates automatically. There's no separate server to run -- a GitHub
  Release *is* the update server.
- Every release is signed with a private key. The app only trusts updates
  signed by the matching public key, which is already committed in
  `tauri.conf.json`'s `plugins.updater.pubkey` -- that value isn't secret,
  it's the whole point of public-key signing.
- After installing, `AppHandle::request_restart()` (a core Tauri method, no
  extra plugin needed) relaunches the app so the new version takes effect
  immediately instead of waiting for the next manual restart.

## The signing key

A keypair was generated for this project (`tauri signer generate`, no
password set on it). The **public key** is already in `tauri.conf.json` and
committed -- nothing to do there.

The **private key** was handed to you separately (not committed to this
repo -- `.gitignore` blocks `*.key`/`*.key.pub` as a backstop, but the real
protection is that it was never written into a tracked file in the first
place). Before the first real release:

1. Save it somewhere durable -- a password manager entry, or a secrets
   vault. If it's lost, you can't ship signed updates anymore and every
   installed copy of the app would need a fresh manual download to move to
   a new key.
2. Add it to this repo's GitHub Actions secrets: **Settings → Secrets and
   variables → Actions → New repository secret**, name
   `TAURI_SIGNING_PRIVATE_KEY`, value = the full contents of the key file.
   That's the only secret needed -- this key wasn't generated with a
   password, and GitHub won't let you save a secret with a blank value
   anyway, so `release.yml` deliberately doesn't reference a
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret at all.

## Cutting a release

1. Bump `"version"` in `src-tauri/tauri.conf.json` (this is what the app
   compares against to decide "is there something newer than me").
2. Commit that change.
3. Tag it and push the tag: `git tag app-v0.2.0 && git push origin app-v0.2.0`
   (must start with `app-v` -- that's what `.github/workflows/release.yml`
   listens for).
4. GitHub Actions builds the Windows installer, signs it with the private
   key secret, and creates a **draft** GitHub Release with the installer +
   `latest.json` attached.
5. Review the draft release, then publish it. The moment it's published,
   every existing install will pick it up on its next launch.

Draft (not auto-published) is deliberate -- gives you a chance to add
release notes or catch a bad build before it goes out to everyone.

## Local testing without waiting on CI

`npx tauri build` locally will also produce signed artifacts if
`TAURI_SIGNING_PRIVATE_KEY` (and `_PASSWORD`) are set as environment
variables in your shell first -- useful for testing the update flow itself
before wiring up CI, or as a fallback if you'd rather not use GitHub
Actions at all and just upload builds to a Release by hand.
