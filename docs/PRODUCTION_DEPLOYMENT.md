# Intercom Global Mesh: Production Deployment & Hardening Guide (`@advance/intercom-global` v2.0.0)

> **Snapshot Date**: `2026-11-25` · **Daemon URL**: `http://127.0.0.1:4150` (port `4150`) · **Fallback Chain**: `opencode -> claude -> hermes -> local-mesh (Zero-Qoder enforced)`

This document defines the deployment architecture, OS tuning, process supervision, Prometheus observability, scheduled maintenance, and governance invariants for running the **Intercom Global Mesh** (`@advance/intercom-global` v2.0.0) in high-throughput production developer environments.

---

## 1. Operating System Invariants & Filesystem Tuning

### 1.1 Windows NTFS Optimizations

The Intercom Global Mesh relies on atomic directory operations (`fs.mkdir` CAS locks) and discrete atomic message writes (`fs.rename` with exponential backoff). To ensure maximum throughput and prevent OS sharing violations:

1. **Windows Defender Exclusion**:
   Real-time anti-virus scanners can hold transient file handles during rapid atomic renames, occasionally inducing `EBUSY` or `EPERM`. Add an exclusion for the mesh working directory:
   ```powershell
   # Run in elevated PowerShell:
   Add-MpPreference -ExclusionPath "$env:USERPROFILE\.intercom-global\mesh"
   ```

2. **Windows Long Paths**:
   Enable Win32 long path support (>260 characters) to prevent `MAX_PATH` truncation for deeply nested session/transcription directories:
   ```powershell
   # Elevated PowerShell:
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```

3. **NTFS 8.3 Short Name Generation**:
   Disabling 8.3 short filename creation improves directory traversal performance in high-volume inboxes:
   ```powershell
   fsutil behavior set disable8dot3 1
   ```

### 1.2 Linux / POSIX Environments

For Linux and macOS deployments:
1. Ensure `ulimit -n` is set to at least 65,536 open file descriptors.
2. Ensure directory permissions on `~/.intercom-global/mesh` are set to `0750` for multi-user isolation.

---

## 2. Service Supervision & Daemon Management

### 2.1 Windows Deployment with NSSM (Non-Sucking Service Manager)

To run Intercom Global as a resilient Windows Service that automatically restarts on failure and boots with the OS:

```cmd
:: 1. Download and extract NSSM (https://nssm.cc)
:: 2. Install the Windows Service
nssm install IntercomGlobalMesh "C:\Program Files\nodejs\node.exe" "C:\Users\Suran\.intercom-global\bin\intercom.js daemon run --port 4150"

:: 3. Configure service parameters
nssm set IntercomGlobalMesh AppDirectory "C:\Users\Suran\.intercom-global"
nssm set IntercomGlobalMesh AppStdout "C:\Users\Suran\.intercom-global\mesh\daemon-stdout.log"
nssm set IntercomGlobalMesh AppStderr "C:\Users\Suran\.intercom-global\mesh\daemon-stderr.log"
nssm set IntercomGlobalMesh AppRotateFiles 1
nssm set IntercomGlobalMesh AppRotateOnline 1
nssm set IntercomGlobalMesh AppRotateBytes 10485760

:: 4. Start the service
nssm start IntercomGlobalMesh
```

### 2.2 Linux Deployment with systemd

Create `/etc/systemd/system/intercom-global.service`:

```ini
[Unit]
Description=Intercom Global Multi-Agent Communication Mesh
After=network.target

[Service]
Type=simple
User=suran
WorkingDirectory=/home/suran/.intercom-global
ExecStart=/usr/bin/node /home/suran/.intercom-global/bin/intercom.js daemon run --port 4150
Restart=always
RestartSec=5
StandardOutput=append:/home/suran/.intercom-global/mesh/daemon.log
StandardError=append:/home/suran/.intercom-global/mesh/daemon-err.log
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now intercom-global
sudo systemctl status intercom-global
```

---

## 3. Prometheus Observability & Telemetry

The Intercom Global Mesh provides a native, zero-dependency Prometheus exporter adhering to Prometheus Text Format 0.0.4.

### 3.1 HTTP Endpoints
- Exposition endpoint: `http://127.0.0.1:4150/metrics` (or `/api/intercom/metrics`)
- CLI command: `intercom metrics` (or `intercom metrics --json`)

### 3.2 Metrics Catalog

| Metric Name | Type | Description |
|---|---|---|
| `intercom_messages_total` | Counter | Total messages dispatched across mesh (labeled by `status`, `recipient`, `type`) |
| `intercom_delivery_latency_ms` | Histogram | End-to-end delivery latency in milliseconds (`_count`, `_sum`, `transport` label) |
| `intercom_mailboxes_total` | Gauge | Total active agent mailboxes currently in mesh |
| `intercom_dlq_messages_total` | Gauge | Total dead-letter queue messages |
| `intercom_active_locks_total` | Gauge | Currently active NTFS CAS advisory locks |
| `intercom_compaction_runs_total` | Counter | Total mailbox compaction cycles executed |
| `intercom_compaction_pruned_dirs_total` | Counter | Total empty mailbox directories pruned |
| `process_uptime_seconds` | Gauge | Daemon uptime in seconds |
| `process_resident_memory_bytes` | Gauge | Resident set size (RSS) memory consumption |
| `process_heap_used_bytes` | Gauge | V8 heap memory used |

### 3.3 Prometheus Scrape Configuration (`prometheus.yml`)

```yaml
scrape_configs:
  - job_name: 'intercom-global-mesh'
    scrape_interval: 15s
    scrape_timeout: 5s
    metrics_path: '/metrics'
    static_configs:
      - targets: ['127.0.0.1:4150']
        labels:
          environment: 'production'
          mesh_node: 'node-01'
```

### 3.4 Grafana Alert Rules Recommendations
- **DLQ Accumulation Alert**: `intercom_dlq_messages_total > 5` for 5 minutes (critical).
- **Stale Lock Alert**: `intercom_active_locks_total > 10` for 2 minutes (indicates crashed process or unrecovered lock).
- **High Memory RSS**: `process_resident_memory_bytes > 500000000` (500MB threshold).

---

## 4. Scheduled Maintenance & Compaction

Over prolonged multi-agent sprints, thousands of ephemeral subagents create discrete message envelopes and temporary files. Routine compaction keeps disk scans fast and reclaims inodes.

By default, `intercom compact` prunes both orphaned temp files and empty mailbox directories (`pruneEmpty: true`). Pass `--no-empty` only when you want to retain empty mailbox directories.

### 4.1 Automated Windows Task Scheduler Setup

Set up an hourly compaction task in Windows:

```powershell
$Action = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "C:\Users\Suran\.intercom-global\bin\intercom.js compact --temp-ttl=30000" `
  -WorkingDirectory "C:\Users\Suran\.intercom-global"

$Trigger = New-ScheduledTaskTrigger -Hourly
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "IntercomGlobalMailboxCompaction" `
  -Action $Action -Trigger $Trigger -Settings $Settings -Description "Hourly Intercom Mailbox Compaction"
```
*(Add `--no-empty` to the argument list if you want to skip pruning empty mailbox directories.)*

### 4.2 Linux Crontab Setup

```bash
# Run hourly mailbox compaction (prunes orphaned temp files and empty mailboxes; pass --no-empty to keep empty directories)
0 * * * * cd /home/suran/.intercom-global && /usr/bin/node bin/intercom.js compact --temp-ttl=30000 >> mesh/compaction.log 2>&1
```

---

## 5. Teamwork & Safety Invariants

Production multi-agent deployments must strictly comply with the following operational invariants:

1. **Zero-Qoder Credit Protection**:
   Under NO circumstance may `qoder` be invoked, triaged, configured as candidate, or listed in automatic fallback chains (`opencode -> claude -> hermes -> local-mesh (Zero-Qoder enforced)`). Any automated configuration specifying `harness: "qoder"` must be immediately rejected at pre-spawn validation; explicit free-tier Qoder calls (when permitted) are strictly constrained to `qwen3.8-flash, qwen3.8, qoder/qwen3.8-flash, glm-5.3-flash, deepseek-flash, minimax-m3.1-flash` (default `qwen3.8-flash`).
2. **Zero-Kill / Subagent Safety Rule**:
   Never kill running processes or subagents without confirmation. Subagents encountering errors or waiting for dependencies must be sent messages or resumed safely.
3. **Antigravity Quota Safety Limits**:
   Always respect provider rate limits. Hold non-critical task launches when capacity drops below the **12% 5-hour limit** or **5% weekly limit**.
4. **Live Registry Cache Hygiene**:
   Keep `mesh/purified-live-cache.json` refreshed every `15` minutes via non-blocking `intercom sync` with strict prompt-injection and shell-metacharacter purification.
5. **Git Commit Discipline**:
   Atomic changes must not exceed **10 files per commit** and must use standard conventional commit scopes (`feat`, `fix`, `test`, `docs`, `refactor`).
