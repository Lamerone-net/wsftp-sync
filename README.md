# WSFTP Sync

Project repository: [Lamerone-net/wsftp-sync](https://github.com/Lamerone-net/wsftp-sync). Use [GitHub Issues](https://github.com/Lamerone-net/wsftp-sync/issues) for bug reports and feature requests.

A TypeScript extension for VS Code that transfers files over SFTP, FTP, and explicit FTPS. This is an independent implementation inspired by the FTP-Sync workflow, with no affiliation to that project.

## Local installation

In VS Code, run **Extensions: Install from VSIX...**, select `wsftp-sync-0.1.50.vsix`, and open a trusted workspace. Alternatively:

```sh
code --install-extension wsftp-sync-0.1.50.vsix
```

## Configuration

The only supported configuration location is `.vscode/wsftp-sync.json` inside each workspace folder. A `wsftp-sync.json` in the workspace root or any other directory is never loaded. An existing `.vscode/ftp-sync.json` is used only to seed a missing configuration; `wsftp.json` is ignored. Existing WSFTP configurations are never merged or overwritten. Use `remote_path` for the server root; the former `remotePath` key is no longer accepted. On activation, when workspace folders are added, or when an existing workspace gains a `.vscode` directory, the extension creates `.vscode/wsftp-sync.json` if missing, using the bundled root-level example and importing common settings from `.vscode/ftp-sync.json` when present. It never creates `.vscode` automatically or overwrites an existing configuration. The explicit configuration command can create the directory and opens the template-based configuration. The root-level [wsftp-sync.json](wsftp-sync.json) is an example only: it is automatically copied into an existing `.vscode` directory when needed. Legacy imports map `login` to `username`, `pass` to `password`, and `remotePath` or `path` to `remote_path`, and preserve host, port, and ignore filters. Explicit current field names take precedence; `remotePath` takes precedence over `path`. Imports keep the template `ignore_always` rules first, then append rules from legacy `ignore_always`, `ignore`, and `ignored`, removing duplicates. Empty legacy lists do not remove template rules. Common legacy patterns are converted to globs: `\.vscode` becomes `**/.vscode/**`, `sftp-settings\.json` becomes `**/sftp-settings.json`, and `/LC_MESSAGES/` becomes `**/LC_MESSAGES/**`. These globs match complete path components; more complex expressions remain in the supported `/pattern/` regex format. Fill in any missing host and credentials before connecting. The root-level example is transferable unless a configured filter excludes it.

Legacy import copies supported same-name fields and maps `pass` to `password`, `remotePath` to `remote_path`, and `uploadOnSave` to `upload_on_save`. Current field names take precedence over aliases. Numeric port strings become numbers; `.` and `./` remote roots become `/`. Legacy `ignore` (or `ignored`) regex strings become `/pattern/` entries in `ignore_always`, replacing the example shared filters; an explicit `ignore_always` takes precedence. Empty lists and `false` values are preserved. Unsupported legacy options are omitted, and missing settings retain the template defaults. `discover` is always `true` in the imported configuration, even if the source says `false`. The legacy file is not modified. Invalid JSON or incompatible settings produce an import error and leave the new file uncreated so the source can be corrected and retried.

Run **WSFTP: Create/open configuration**, enter your server settings, and use **WSFTP: Set credential** to store a password in VS Code SecretStorage. Stored credentials take precedence over JSON credentials and are associated with the workspace, protocol, host, port, username. **WSFTP: Remove saved credential** removes that stored value; a JSON credential can still be used. Manual operations can prompt for a temporary password. Automatic uploads never open credential or trust prompts, so perform a manual transfer first.

### Options in the example

| Option | Required / default | Purpose and behavior |
| --- | --- | --- |
| `username` | Required to activate operations | Account used to authenticate to the server. Missing, null, empty, or whitespace-only values keep the extension inactive: no connections, discovery, transfers, or configuration validation messages. |
| `password` | Required to activate operations | Server password for password authentication. A stored VS Code credential overrides this value. A nonempty value is required even when using SecretStorage. |
| `host` | Required string | Server hostname or IP address, without a URL scheme or directory path. |
| `remote_path` | Required; `/` during discovery if omitted | Existing absolute server directory mapped to the workspace root. For example, `/var/www` maps local `assets/a.css` to `/var/www/assets/a.css`. Use `/` separators; `..` and backslashes are rejected. |
| `port` | SFTP: `22`; FTP/FTPS: `21`; required for discovery | Integer from 1 to 65535. Set a different port when required by your server. |
| `protocol` | Required unless `discover: true` | `sftp` uses SSH; `ftp` uses FTP; `ftps` uses explicit FTP over TLS. Implicit FTPS is unsupported. |
| `upload_on_save` | `false` | Automatically uploads the saved document if it is not excluded. It does not synchronize the entire workspace or generated files. Requires a trusted workspace and previously authorized connection. |
| `autosync` | `false` in the example | Enables periodic checks and notifications; transfers still require Apply. Explicit true/false overrides the VS Code autoCheck.enabled setting. |
| `autosync_secs` | `120` seconds | Integer from 1 to 86400. Delay after an automatic check completes before the next check; checks never overlap. |
| `passive` | `true` | Accepts `true` or `false`. With `true`, FTP/FTPS sends `EPSV` (or falls back to `PASV`) before data transfers. With `false`, no passive command is sent: active mode uses `PORT` for IPv4 or `EPRT` for IPv6 so the server connects back to the client. Applies to listings, uploads, and downloads. No effect on SFTP. |
| `debug` | `false` | When `true`, writes protocol diagnostics and operation messages to **Debug Console** and **Output > WSFTP Sync**. Includes FTP/FTPS commands and complete server replies, SSH/SFTP diagnostics, scans, comparisons, and transfers. Passwords are redacted. When `false`, protocol diagnostics are disabled and Output shows only the latest status line, replacing the previous content. When `true`, Output retains the full message history. |
| `ignore_always` | `[]` | Paths, glob patterns, or PCRE2 regexes excluded from both upload and download. No additional exclusions are added automatically. A directory excludes all descendants. |
| `ignore_upload` | `[]` | Excludes matching files/directories only from uploads, including upload on save. Does not exclude downloads. |
| `ignore_download` | `[]` | Excludes matching files/directories only from downloads. Does not exclude uploads. |

The illustrative filenames under `ignore_upload` and `ignore_download` in the supplied example are reversed: the option name determines the direction, regardless of the filenames inside it. For clearer examples:

```json
"ignore_always": ["hidden_dir", "credentials.json"],
"ignore_upload": ["do_not_upload_dir", "do_not_upload_file.php"],
"ignore_download": ["do_not_download_dir", "do_not_download_file.php"]
```

Use the exact option names shown above. Camel-case aliases such as `uploadOnSave` and `ignoreAlways` are rejected.

All three exclusion lists are relative to the workspace root. Use paths such as `assets/local.css` or globs such as `**/*.log`. Leading `./`, trailing `/`, and Windows separators are normalized. Empty lists add no rules; `!` negation is rejected. Rules apply to individual transfers, root and directory synchronization, and previews. They do not remove existing files on either side.

The `secure` option has been removed and is rejected as unknown. Select encryption through `protocol` only: `sftp` for SSH, `ftps` for explicit TLS, or `ftp` for unencrypted FTP. To migrate `"protocol": "ftp", "secure": true`, remove `secure` and set `"protocol": "ftps"`.

### Protocol discovery

Set `"discover": true` in `.vscode/wsftp-sync.json` and save that file to start discovery. A manual upload, download, or synchronization command also starts discovery while this flag is enabled. Other saved documents do not start discovery or upload files. Discovery never uploads or downloads files. On success it automatically updates `.vscode/wsftp-sync.json`: sets `discover` to `false`, sets `protocol`, and sets `passive` for FTP/FTPS or keeps it as `false` for SFTP. Other settings are preserved. If `remote_path` was omitted, it adds `/`, the directory tested during discovery.

```json
{
  "discover": true,
  "host": "example.com",
  "port": 21,
  "username": "ftp_username",
  "password": "ftp_password"
}
```

`discover` is a boolean and defaults to `false`. The explicit `port` is used for every attempt; no other ports are scanned. The order is SFTP, FTPS passive, FTPS active, FTP passive, FTP active. Discovery stops at the first successful connection and directory listing and immediately shows the settings popup; later protocols are not attempted. Existing `protocol` and `passive` settings do not determine the trial order. Discovery uses password authentication, requires a nonempty `password` in the configuration and does not use private keys or stored protocol-specific credentials. A fixed 15-second timeout applies to connection attempts, so several failures can take time; cancellation stops subsequent attempts after an ongoing operation finishes or times out.

A successful attempt must authenticate and list `remote_path` (default `/` during discovery), which checks the FTP data mode as well as the control connection. Listing permission failures can therefore prevent detection. During discovery, an untrusted FTPS certificate opens the certificate verification popup described below. SFTP requires a trusted host key; rejecting it stops discovery.

Before trying unencrypted FTP, a warning asks permission to send credentials in plain text and explains the high risk of interception. Refusing stops discovery. After saving the changes, a modal popup confirms "The configuration file has been updated." and lists the changed settings. No manual configuration edit is required. If the file changed during discovery or has unsaved editor changes, it is not overwritten and an error asks you to retry. For SFTP, the saved settings and popup include `"passive": false`; this option has no effect on SFTP. An FTP result repeats the security warning. If no attempt succeeds, an error points to the Output logs; no settings are guessed. Transfers can resume on the next operation using the updated configuration.

### Strict option validation

If any of `username`, `password`, or `host` is missing, null, empty, or whitespace-only, the extension silently skips all operations before validating other settings. No discovery, transfer, connection, or credential prompt is started, even if a stored credential exists. The JSON must still be syntactically valid to read these fields.

Only the 15 keys in the example are accepted: `username`, `password`, `host`, `remote_path`, `port`, `upload_on_save`, `autosync`, `autosync_secs`, `discover`, `protocol`, `passive`, `ignore_always`, `ignore_upload`, `ignore_download`, and `debug`.

All other keys are rejected, including old aliases, `exclude`, `timeout`, SSH key settings, `secureOptions`, and `$schema`. A single unknown key produces `invalid option <name>`; multiple unknown keys are listed together. Values are not exposed in the message. Invalid values for recognized options also stop the operation. Workspaces without a supported configuration are ignored on save.

Connection timeout is fixed at 15000 milliseconds. Authentication uses passwords. FTPS certificates must pass normal validation or be explicitly accepted by fingerprint; SFTP host fingerprints are verified and stored through the trust prompt.

Active mode (`passive: false`) advertises the local address of the control connection and a temporary listening port. The server must be able to reach that address and port; NAT or a firewall can block the connection. There is no automatic fallback to passive mode. FTPS keeps the data connection encrypted in either mode.

FTP requires initial approval because credentials and files travel in plain text. FTPS requires a valid TLS certificate by default. SFTP requires host-key verification. Enable `upload_on_save` after checking a manual connection and destination.

## FTPS certificate verification

If an FTPS certificate is self-signed or otherwise not automatically trusted, a modal popup shows the host, port, SHA256 fingerprint, subject, issuer, validity dates, and validation error. Verify the fingerprint with your server administrator and choose **Trust this certificate** to continue. The decision is requested before sending username or password.

The accepted fingerprint is stored in VS Code for that host and port and reused by discovery and normal connections. A different certificate requires a new confirmation. Automatic uploads never open trust prompts: an unknown or changed certificate stops the upload and asks you to run a manual operation. Rejecting the certificate stops discovery rather than falling back to unencrypted FTP.

Data connections use the accepted certificate chain and must match the control connection fingerprint; TLS chain and date checks still apply. No configuration option disables certificate verification globally.

## Transfers and synchronization

The only extension keyboard shortcuts are:

| Shortcut | Command | Behavior |
| --- | --- | --- |
| Ctrl+Alt+U | WSFTP: Synchronize root: Upload | Upload new/modified files and create missing directories, including empty ones. |
| Ctrl+Alt+D | WSFTP: Synchronize root: Download | Download new/modified files and create missing local directories, including empty ones. |
| Ctrl+Alt+S | WSFTP: Synchronize: Bidirectional | Upload local changes and download remote changes; skip conflicts. |

All three start from the active file's workspace root (or the first workspace folder when no workspace file is active), show an Apply/Cancel preview, and never delete destination-only content. They work with autosync disabled. No other shortcuts or platform-specific alternative bindings are contributed. The commands also remain accessible through the Command Palette if Windows intercepts a key combination.

The local/remote dominance commands remain available in the Command Palette without shortcuts. These modes additionally propose deletions.

Bidirectional synchronization compares each file's content against its last successfully agreed size/CRC32 fingerprint. Identical copies establish that baseline; successful transfers update it. A changed local copy is uploaded when the remote copy still matches the baseline, and vice versa. Different edits on both sides, or different initial copies without a baseline, are listed as **CONFLICT** and skipped. Resolve them manually or use a dominance preview to select a side. File/directory type mismatches and their descendants are skipped in all three modes. There is no automatic merge or conflict backup.

Dominance deletes individual destination-only files, then removes directories from deepest to shallowest only if empty. Ignored content and symbolic links protect their parent directories from deletion; no recursive delete is used. New content or changed metadata detected after preview stops the operation. Completed operations remain applied if a later operation fails or is cancelled. Deletions have no built-in undo. The bidirectional mode restores one-sided missing files by copying the surviving version; it never propagates deletions.

`ignore_always` applies to every mode. Local dominance additionally uses `ignore_upload`, remote dominance uses `ignore_download`; these rules also protect paths from deletion. Bidirectional scanning uses the shared exclusions, then applies the appropriate direction-specific rules to each proposed copy. Empty directories are included.

The existing transfer-only commands remain available:


- **WSFTP: Upload file** and **WSFTP: Download file** operate on the file selected in Explorer or the active editor. Downloads require confirmation before overwriting.
- **WSFTP: Upload root** and **WSFTP: Download root** compare local/server and server/local files from the project root to the configured `remote_path`. No directory prompt is shown. In multi-root workspaces, these commands use the active file's workspace folder, or the first folder if no workspace file is active. Search for `wsftp` in Keyboard Shortcuts to customize the bindings.
- The preview lists files that are new or differ in size or CRC32. **Apply**, the default Enter action, transfers the entire list; **Cancel** or Escape cancels. There is no second confirmation. A message appears when no differences are found.
- The Explorer folder context menu provides **WSFTP: Upload dir** and **WSFTP: Download dir**, with the same preview restricted to the selected directory and its descendants. Paths remain relative to the workspace root: `sub/file.php` maps to `remote_path/sub/file.php`.
- The synchronization command (`wsftp.sync`) lets you choose upload or download and opens the same preview for the root. Downloads include remote files that do not yet exist locally.
- The existing transfer-only root and Explorer upload/download commands include all nonexcluded subdirectories and remain transfer-only; the new dominance commands above also propose deletions.
- Operations run sequentially within each workspace folder. Commands that require workspace selection prompt when multiple folders are available; root synchronization follows the active-file rule above.
- Downloads use a temporary file in the destination directory, so a transfer failure preserves the previous file. Uploads overwrite remote files directly; an interruption can leave an incomplete remote file.
- File metadata is checked again before each synchronization transfer. Synchronization is not transactional and cannot isolate concurrent changes on the server.
- Cancellation stops scans or subsequent transfers. An ongoing transfer finishes before cancellation takes effect. Completed transfers remain applied and are recorded in the log even if a later operation fails.

### Optional automatic checks

Set `"autosync": true` in `.vscode/wsftp-sync.json` to enable monitoring, or `false` to disable it:

```json
"autosync": true,
"autosync_secs": 120
```

The bundled example defaults to `false`. **WSFTP: Toggle automatic checks** now updates this JSON option, preserving the other configuration values. Changes take effect when the file is saved, or within the next polling cycle for external edits. The option controls checks and notifications only; it does not apply transfers automatically.

An explicit `autosync` value overrides `wsftp.autoCheck.enabled`. When the JSON option is omitted, the existing VS Code enable setting remains the fallback for compatibility (disabled by default).

`autosync_secs` controls the interval in seconds, accepts integers from 1 to 86400, and defaults to **120 seconds (two minutes)** when omitted. It replaces the former `wsftp.autoCheck.intervalMinutes` setting, which is no longer used. The first observation starts within approximately 15 seconds of enabling; subsequent checks wait the configured interval after the previous check finishes. Scheduling may be delayed while another workspace or manual operation is busy. Saved interval changes take effect without reloading the extension. Remote paths are considered only after their metadata remains unchanged in two successful observations, so the first remote notifications normally arrive after the second check. This reduces notifications for files still being generated, but cannot prove that a remote writer has finished.

A status-bar item for each enabled workspace shows download, upload, and conflict counts, plus an indicator when remote paths are waiting for stability. A notification appears for newly detected differences rather than repeating the same pending items on every scan. The notification closes after five seconds or before the next scan, so notices cannot accumulate. Click the status item to run a fresh bidirectional preview for that workspace. Only **Apply** in that preview performs copies; background checks never upload, write workspace files, create remote directories, or delete anything. CRC32 verification can still download temporary remote copies outside the workspace and update extension cache/history.

Checks respect ignore rules and use the existing bidirectional conflict handling. They run without overlapping and share each workspace's operation queue. Manual operations interrupt background scanning at its next cancellation checkpoint; an in-flight network operation finishes first. Disabled monitoring, removed workspace folders, and extension disposal stop future checks and suppress pending results. Connection failures appear in the status bar and logs, without repeated error popups. Configure credentials, authorize FTP, and trust any required SFTP host key or FTPS certificate through a manual operation first: background checks never open password, discovery, or trust prompts.

Notification deduplication and stability observations last for the current extension session. Restarting VS Code starts a new pair of observations. Directory listings still require server requests even when all content hashes are cached; increasing the interval reduces that traffic. The three manual synchronization shortcuts continue working with automatic checks disabled.

### File comparison strategy

The existing transfer-only root and directory commands use the following upload rules. If the remote file is missing, it is included in the upload immediately. Otherwise:

1. If the local and remote file sizes differ, upload the file without calculating CRC32.
2. If the sizes match, reuse each side's cached CRC32 when its own size and modification time are unchanged; calculate missing or stale hashes.
3. If the CRC32 values differ, upload the file.
4. If the CRC32 values match, skip the upload.

Files requiring an upload appear in the preview and are transferred when you select **Apply**. Download synchronization uses the same comparison in the opposite direction.

Modification-time (`mtime`) differences between local and remote do not determine whether a file needs a transfer. Persistent cache entries contain the complete relative path, size, mtime, and CRC32 for each side. Caches live in VS Code extension storage outside the project and are isolated by workspace, protocol, host, port, username, remote root. Ignored directories are pruned before scanning. Missing or zero timestamps force content verification. Metadata is still rechecked during content verification and before transfers after the preview.

CRC32 is calculated incrementally. For equal-size files with no valid remote hash in the cache, verification downloads a temporary remote copy and uses disk space for one file at a time; it does not overwrite workspace files. CRC32 can have collisions and is not a cryptographic guarantee of equality. Synchronization downloads preserve remote timestamps when available.

The first comparison is still expensive; subsequent scans list remote directories but avoid downloading unchanged files for verification. Changes that preserve both size and mtime require **WSFTP: Clear synchronization cache** followed by synchronization to be detected. Cancelled previews keep differences pending. The new modes record successful transfers in the cache and synchronization history. Legacy transfer-only commands invalidate affected cache entries before writing. Clearing the cache preserves synchronization history, so a full verification can still identify which side changed. Cancelled previews never acknowledge differing contents. Bidirectional comparison may need remote hashes even for different-size files to identify the changed side.

These comparison rules apply to synchronization previews. **WSFTP: Upload file** and `upload_on_save` upload the selected or saved file directly, without a CRC32 comparison.

There are no hardcoded exclusions. Only `ignore_always`, `ignore_upload`, and `ignore_download` control path filtering. The rules included in the example are editable suggestions: remove them or use empty lists to include all regular files and directories, including `.git`, `.vscode`, `node_modules`, `.env`, keys, and the configuration itself. Symbolic links are skipped during scans and rejected in transfer paths below configured directories. Names that are not portable to Windows are rejected. Implicit FTPS, proxies, SSH agents, multiple profiles within one folder, and permission management are unsupported.

## Output logs

Run the WSFTP log command (`wsftp.log`) to open **Output > WSFTP Sync**. Logs include timestamps, connection protocol, host, port, username, remote directory, timeout, directory scans, synchronization comparisons, transfer starts and results, exclusions, cancellations, and errors. Comparisons report whether source files are new, modified, or synchronized by size and CRC32. Temporary downloads during content verification are logged and do not overwrite workspace files.

Manual transfers and synchronization show a connection progress notification with the target host and port while connecting and logging in. The notification closes when connection succeeds or fails; failures then show the specific error. Single-file transfers also show remote inspection and upload/download progress. Automatic checks and upload on save do not show these progress notifications.

Connection and transfer diagnostics redact the configured password and session secret. Set `debug: true` to enable raw protocol diagnostics. Open **View > Debug Console** to see them; the extension writes directly through the VS Code Debug Console API, so an Extension Development Host is not required. Multiline server replies are preserved there. The Output channel also contains these diagnostics, with line breaks flattened. Debugging is read again for each operation; set it to `false` to disable protocol logging on the next connection. Logs contain server addresses and file paths, so review them before sharing.

## Direction-specific exclusions

`.vscode/wsftp-sync.json` supports:

```json
"ignore_upload": ["original_documents", "config/local.php"],
"ignore_download": ["output", "assets/local.css"]
```

Paths are relative to the project root and use `/` separators. A directory excludes all descendants. Glob patterns such as `**/*.log` are supported. These lists accept paths/globs and explicit `/pattern/flags` PCRE2 regular expressions.

`ignore_upload` applies only to uploads; `ignore_download` applies only to downloads. Rules cover individual files, upload on save, root synchronization, and directory commands. Excluded files do not appear in previews. Shared rules (`ignore_always`) apply in both directions. Empty lists add no exclusions; `!` negation is unsupported.

## Perl-compatible ignore expressions

All three ignore lists support PCRE2 10.47 regular expressions in `/pattern/flags` form, alongside existing paths and globs. A value starting with `/` is treated as a regex; other values retain glob semantics. Regex backslashes are preserved and are never converted to path separators.

```json
"ignore_always": [
  "/^\\.git(?:/|$)/",
  "/(?:^|/)\\.env(?:\\.[^/]*)?$/",
  "node_modules/**"
],
"ignore_upload": ["/\\.(?:bak|tmp)$/i"],
"ignore_download": ["/^uploads(?:/|$)/"]
```

JSON requires doubled backslashes: the pattern `\.php$` is written as `"/\\.php$/i"` inside JSON. Supported suffix flags are `i` (case-insensitive), `m` (multiline), `s` (dot matches newline), `x` (extended syntax), and `u` (UTF). Use PCRE2 inline options for additional modes, such as `(?U)` for ungreedy matching. PCRE2 supports Perl-style constructs including lookarounds, backreferences, atomic groups, and `\K`; it is not the JavaScript RegExp engine and does not execute Perl code.

Matching uses workspace-relative paths with `/` separators. Regexes search anywhere unless anchored with `^`/`$`. Ancestor paths are checked too, so matching a directory excludes its descendants. Omitted or empty lists still exclude nothing automatically.

Malformed regexes or unsupported flags stop the operation with the list name and zero-based entry index, for example `Invalid regex in ignore_upload[0]`. Compiled patterns are cached (up to 256) and reused. Matching has backtracking and recursion limits; exceeding a limit reports an error instead of silently treating the file as included. The WASM engine is loaded only when regex filters are used and is bundled with the extension, with no runtime download or native installation required.

## Development

Requires Node.js 22 or later and VS Code 1.96 or later.

```sh
npm install
npm test
npm run package
```

On Windows, use `npm.cmd` if PowerShell blocks scripts. Press F5 to open the Extension Development Host. Automated tests cover configuration, exclusions, paths, synchronization planning, download handling, real transfers against local SFTP/FTP/FTPS servers, and rejection of invalid host keys, passwords, and certificates. The VSIX uses SSH2's JavaScript fallback and excludes optional native accelerators. Verify the Extension Development Host interface and behavior against your server using a dedicated remote directory, including previews and upload on save.

Keep documentation, changelogs, code comments, and other developer-facing text in English.

For Marketplace publication, replace `publisher: sparviero-local` with a registered publisher and verify the public extension name before rebuilding. Repository metadata and an icon are included. Packaging does not publish the extension. See [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

Libraries: [pcre2-wasm](https://github.com/gudoshnikovn/pcre2-wasm), [ssh2-sftp-client](https://github.com/theophilusx/ssh2-sftp-client), [basic-ftp](https://github.com/patrickjuchli/basic-ftp). Licensed under GPL-3.0-only; see LICENSE.
