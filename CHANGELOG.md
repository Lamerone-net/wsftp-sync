# Changelog

## 0.1.29

- Document the four-step size/CRC32 synchronization strategy, temporary verification downloads, and the scope of direct file uploads.
- Clarify that modification-time differences do not trigger transfers and no synchronization cache is used.

## 0.1.28

- Ignore modification-time differences when comparing local and remote files: transfer missing or different-size files immediately and compare equal-size contents using CRC32.
- Fix repeated synchronization differences after uploads to servers that assign or truncate remote timestamps, without a synchronization cache.
- Simplify the example exclusions using equivalent Perl-compatible regexes.

## 0.1.27

- Add PCRE2 Perl-compatible regex filters in /pattern/flags form to all three ignore lists while preserving paths and globs.
- Validate regexes with indexed configuration errors, preserve regex escapes, and cache compiled patterns with bounded matching work.
- Bundle the WebAssembly engine for offline Windows/VS Code use without native dependencies.

## 0.1.26

- Prompt to verify and trust self-signed FTPS certificates by SHA256 fingerprint before sending credentials.
- Remember accepted certificates per host and port for discovery and transfers; require renewed trust for changed certificates.
- Stop discovery on certificate rejection and require manual verification before automatic uploads to an untrusted server.
- Verify data connections against the accepted certificate and add TLS-required discovery and self-signed transfer regression coverage.

## 0.1.25

- Remove all hardcoded path exclusions and automatic key-file exclusions. Only configured ignore_always, ignore_upload, and ignore_download rules filter paths.
- Treat example exclusions as editable suggestions; empty or omitted lists exclude nothing.

## 0.1.24

- Silently suspend all operations when username, password, or host is missing, null, empty, or whitespace-only.
- Apply this prerequisite before discovery, transfers, credential prompts, and further configuration validation.

## 0.1.23

- Initialize missing .vscode/wsftp-sync.json files from the bundled example only when .vscode exists, without overwriting existing files.
- Silently suspend discovery, transfers, and further configuration validation when username is missing or blank.
- Use the same template for the explicit configuration command.

## 0.1.22

- Accept only the 13 configuration keys present in the example; reject all other options and legacy aliases.
- Align JSON schema and documentation with the exact supported set. Keep the connection timeout fixed at 15 seconds and certificate verification enabled.

## 0.1.21

- Reject uploadOnSave as an invalid configuration option; require upload_on_save.
- Report a single unrecognized field as invalid option followed by its name, while retaining combined reports for multiple unknown fields.

## 0.1.20

- Keep discover in the configuration after successful detection and set it to false; include the updated value in the confirmation popup.

## 0.1.19

- Keep passive in the configuration after discovery, setting it to false for SFTP, and show that value in the confirmation popup.

## 0.1.18

- Automatically apply successful discovery settings to .vscode/wsftp-sync.json and remove discover; remove passive for SFTP.
- Confirm the saved settings in a popup and include the interception warning for FTP. Preserve unrelated settings and refuse to overwrite concurrent or unsaved edits.

## 0.1.17

- Try SFTP first during discovery, then FTPS, and finally FTP, stopping at the first working protocol/data mode.
- Preserve the settings popup, removal reminder, and unencrypted FTP security warnings.

## 0.1.16

- Add discover mode to test FTPS passive/active, SFTP, and FTP passive/active on the configured port using authentication and directory listing only.
- Show suggested settings and a reminder to remove discover; suspend transfers while discovery is enabled.
- Require explicit approval before unencrypted FTP attempts and repeat the credential-interception warning for FTP results.
- Preserve TLS and SSH host verification during discovery, with cancellation, diagnostics, and connection cleanup.

## 0.1.15

- Remove the secure configuration option; protocol alone selects SFTP, explicit FTPS, or unencrypted FTP.
- Reject secure as an unknown option and update the example and migration documentation to use protocol: ftps.

## 0.1.14

- Accept both boolean values for passive: true uses EPSV/PASV, while false uses active FTP with PORT/EPRT and never sends passive commands.
- Support active FTP/FTPS directory listings, uploads, and downloads with data-connection TLS, timeouts, peer checks, and listener cleanup.
- Document active-mode connectivity requirements and preserve passive mode as the default.

## 0.1.13

- Load configuration exclusively from .vscode/wsftp-sync.json in each workspace folder; never fall back to the workspace-root example.
- Update configuration guidance and schema association to require the .vscode location.
- Include all built-in exclusions in the example configuration.

## 0.1.12

- Read only wsftp-sync.json from .vscode or the workspace root; remove ftp-sync.json and wsftp.json discovery and schema associations.
- Report all unknown configuration options together, including unsupported secureOptions fields, without exposing their values.

## 0.1.11

- Use upload_on_save, ignore_always, ignore_upload, and ignore_download in examples, generated configuration, schema descriptions, and documentation.
- Accept uploadOnSave for compatibility while giving upload_on_save precedence, including an explicit false value.

## 0.1.10

- Support wsftp-sync.json in the workspace root or .vscode, including ignoreAlways, ignoreUpload, and ignoreDownload exclusions with compatibility aliases and FTP-compatible settings.
- Enable credential-redacted FTP/FTPS commands, server replies, SFTP diagnostics, and operation logs in the Debug Console when debug is true.
- Document every configuration option, defaults, compatibility behavior, and debug output.

## 0.1.9

- Translate all extension commands, prompts, errors, logs, and configuration descriptions into English.

- Immediately schedule transfers when file size or modification time differs, skipping content reads, temporary downloads, and CRC32 verification.
- Reserve CRC32 verification for files with exactly matching size and modification time in both synchronization directions.

## 0.1.8

- Compare every equal-size file pair using streaming CRC32, even when modification times match.
- Use size differences directly and keep timestamps for diagnostics and concurrent-change checks.
- Log local and remote CRC32 values and comparison reasons.

## 0.1.7

- Verify SHA256 content when equal-size files have different timestamps, preventing repeated uploads of identical files after the server changes their modification time.
- Apply verification to both sync directions, with temporary-file cleanup and metadata revalidation during comparison.

## 0.1.6

- Show a specific English message for invalid configuration JSON, including the affected filename without exposing file contents.
- Distinguish JSON syntax errors from configuration file read errors.

## 0.1.5

- Translate project documentation and release notes into English and establish English as the language for developer-facing text.
- Document the Output logging added in 0.1.4 and update installation instructions.

## 0.1.4

- Add timestamps, connection details, scans, synchronization comparisons, transfers, and operation results to the WSFTP Sync Output channel.
- Log exclusions, cancellations, and errors with credentials redacted from diagnostic details.

## 0.1.3

- Add `ignore_upload` and `ignore_download` to exclude paths and globs in the specified direction across all commands and upload on save.

## 0.1.2

- Compare from the workspace root with an Apply/Cancel modal preview using Ctrl+Alt+U/D.
- Add Explorer Upload dir and Download dir commands that scan only the selected directory.
- Use a single confirmation to transfer all listed files.

## 0.1.1

- Support `.vscode/ftp-sync.json`, legacy credentials, FTPS through `secure`, certificate options, and `ignore` filters.
- Add Ctrl+Alt+U and Ctrl+Alt+D upload/download shortcuts (Cmd on macOS).
- Report configuration errors and unmet automatic-upload prerequisites.

## 0.1.0

- Initial release with SFTP, FTP, and explicit FTPS support.
- Add individual upload/download, upload on save, and SecretStorage credentials.
- Add recursive directional synchronization with a selectable preview and confirmation.
- Support exclusions, host key/TLS verification, temporary-file downloads, and multi-root workspaces.
