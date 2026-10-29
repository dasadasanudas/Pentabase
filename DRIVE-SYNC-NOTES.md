# Pentabase Google Drive sync: experimental

The existing GitHub Pages site is unchanged. `drive-index.html`, `drive-shim.js`, and `drive-sync.js` are the staged Drive integration. They are not used by the current Pages build yet. No Google account has been connected.

## Setup still required

1. Create a Google Cloud project and enable the Google Drive API.
2. Configure the Google Auth Platform consent screen, use External testing, and add the intended Google account as a test user.
3. Create a Web application OAuth client with `https://dasadasanudas.github.io` as an authorized JavaScript origin. The OAuth client ID is public; never commit a client secret or access token.
4. Test real Google authorization, upload, conflict behavior, and restore against a separate empty test library before enabling the production Pages deployment.

## Prototype behavior

The app requests the Google Drive `drive.file` scope. Sync uploads an immutable snapshot of the local SQLite database and attachments; Drive copies are private unless shared, but are not end-to-end encrypted. Access tokens are held only in the browser tab. Each snapshot consumes Drive storage. The test build limits the total uncompressed library to 64 MiB. Restore targets a separate empty folder and requires desktop Chrome or Edge. Multiple conflicting heads are preserved rather than overwritten; conflict-resolution UI is not yet implemented.

Do not edit one library on multiple devices simultaneously. Keep independent backups. Tests used simulated Google Identity and Drive responses: real-account authorization and API behavior remain unverified.
