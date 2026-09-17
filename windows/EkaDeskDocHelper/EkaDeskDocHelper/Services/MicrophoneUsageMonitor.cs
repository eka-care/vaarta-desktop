using System;
using System.Diagnostics;
using System.Linq;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace EkaDeskDocHelper.Services;

internal sealed class MicrophoneUsageMonitor : IMicrophoneUsageMonitor
{
    // Mic must stay idle this long before we report "not in use" — meeting apps briefly release it on audio reconnect.
    private static readonly TimeSpan IdleConfirmationWindow = TimeSpan.FromSeconds(2);

    private readonly object _gate = new();

    private Thread? _workerThread;
    private CancellationTokenSource? _cts;
    private bool _micActive;
    private int _activeSessionCount;
    private HashSet<uint> _activePids = new();
    private DateTime? _idleSince;

    private bool _started;
    private bool _disposed;

    // If our own Electron app (or helper) is recording, it will keep the capture session "active".
    // We intentionally ignore those sessions so this monitor can still detect "other apps" usage
    // starting/stopping and drive overlay intent to Electron (source-of-truth).
    private static readonly string[] IgnoredProcessNames =
    [
        "EkaDeskDocHelper",
        "DeskDocEka",
        "EkaScribe",
        "electron",
    ];

    public event EventHandler<MicrophoneUsageChangedEventArgs>? MicrophoneUsageChanged;

    public void Start()
    {
        ThrowIfDisposed();

        lock (_gate)
        {
            if (_started) return;
            _started = true;
        }

        Console.WriteLine("Mic monitor: initializing (WASAPI Audio Session Manager).");

        _cts = new CancellationTokenSource();
        _workerThread = new Thread(() => WorkerLoop(_cts.Token))
        {
            IsBackground = true,
            Name = "MicrophoneUsageMonitor",
        };
        _workerThread.SetApartmentState(ApartmentState.STA);
        _workerThread.Start();
    }

    private void WorkerLoop(CancellationToken token)
    {
        // NAudio CoreAudio wrappers sit on top of COM. Using an STA thread keeps
        // COM objects + enumeration stable and avoids UI thread stalls stopping polling.
        using var enumerator = new MMDeviceEnumerator();

        while (!token.IsCancellationRequested)
        {

            try
            {
                PollOnce(enumerator);
            }
            catch (Exception ex)
            {
                // Never allow the loop to die; transient COM issues can happen on device changes.
                Console.WriteLine($"Mic monitor: poll error: {ex.GetType().Name}: {ex.Message}");
            }

            try
            {
                Thread.Sleep(1000);
            }
            catch
            {
                // ignore
            }
        }
    }

    private void PollOnce(MMDeviceEnumerator enumerator)
    {
        lock (_gate)
        {
            if (_disposed) return;
        }

        var activePidSet = new HashSet<uint>();
        foreach (var role in new[] { Role.Console, Role.Multimedia, Role.Communications })
            CollectActiveSessionPidsForRole(enumerator, role, activePidSet);
        var activeCount = activePidSet.Count;

        var isActive = activeCount > 0;
        var raiseChanged = false;
        var hasNewSession = false;
        var previousActiveCount = 0;

        lock (_gate)
        {
            if (_disposed) return;

            if (isActive)
            {
                _idleSince = null;
            }
            else if (_activeSessionCount == 0)
            {
                _idleSince = null;
                return;
            }
            else
            {
                _idleSince ??= DateTime.UtcNow;
                if (DateTime.UtcNow - _idleSince.Value < IdleConfirmationWindow) return;
                _idleSince = null;
            }

            if (activePidSet.SetEquals(_activePids)) return;

            hasNewSession = activePidSet.Any(pid => !_activePids.Contains(pid));
            previousActiveCount = _activeSessionCount;
            _activeSessionCount = activeCount;
            _activePids = activePidSet;
            _micActive = isActive;
            raiseChanged = true;
            if (isActive)
                Console.WriteLine($"Mic in use: STARTED (active sessions={activeCount}).");
            else
                Console.WriteLine("Mic in use: STOPPED (no active sessions).");
        }

        if (raiseChanged)
        {
            string? appName = isActive ? GetFirstActiveSessionAppName(enumerator) : null;
            MicrophoneUsageChanged?.Invoke(
                this,
                new MicrophoneUsageChangedEventArgs(
                    isActive,
                    previousActiveCount,
                    activeCount,
                    appName,
                    hasNewSession));
        }
    }

    private static void CollectActiveSessionPidsForRole(
        MMDeviceEnumerator enumerator, Role role, HashSet<uint> pids)
    {
        MMDevice? device = null;
        AudioSessionManager? sessionManager = null;
        try
        {
            device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, role);
            sessionManager = device.AudioSessionManager;
            for (var i = 0; i < sessionManager.Sessions.Count; i++)
            {
                var s = sessionManager.Sessions[i];
                if (s.State != AudioSessionState.AudioSessionStateActive) continue;
                if (IsIgnoredSession(s)) continue;
                var pid = s.GetProcessID;
                if (pid > 0) pids.Add(pid);
            }
        }
        catch { /* transient COM errors */ }
        finally
        {
            sessionManager?.Dispose();
            device?.Dispose();
        }
    }

    private static string? GetFirstActiveSessionAppName(MMDeviceEnumerator enumerator)
    {
        foreach (var role in new[] { Role.Console, Role.Multimedia, Role.Communications })
        {
            MMDevice? device = null;
            AudioSessionManager? sessionManager = null;
            try
            {
                device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, role);
                sessionManager = device.AudioSessionManager;
                for (var i = 0; i < sessionManager.Sessions.Count; i++)
                {
                    var s = sessionManager.Sessions[i];
                    if (s.State != AudioSessionState.AudioSessionStateActive) continue;
                    if (IsIgnoredSession(s)) continue;
                    var name = GetSessionDisplayName(s);
                    if (!string.IsNullOrWhiteSpace(name)) return name;
                }
            }
            catch { /* ignore — transient COM errors */ }
            finally
            {
                sessionManager?.Dispose();
                device?.Dispose();
            }
        }
        return null;
    }

    private static string? GetSessionDisplayName(AudioSessionControl session)
    {
        try
        {
            var pid = session.GetProcessID;
            if (pid <= 0) return null;
            using var proc = Process.GetProcessById((int)pid);
            // Prefer human-readable product name from version info; fall back to process name.
            var productName = proc.MainModule?.FileVersionInfo.ProductName;
            if (!string.IsNullOrWhiteSpace(productName)) return productName.Trim();
            return string.IsNullOrWhiteSpace(proc.ProcessName) ? null : proc.ProcessName;
        }
        catch { return null; }
    }

    private static bool IsIgnoredSession(AudioSessionControl session)
    {
        try
        {
            // NAudio exposes AudioSessionControl2 under the hood; GetProcessID exists there.
            // Some sessions might not have a valid PID; treat those as not ignored.
            var pid = session.GetProcessID;
            if (pid <= 0) return false;

            using var proc = Process.GetProcessById((int)pid);
            var name = proc.ProcessName;
            if (string.IsNullOrWhiteSpace(name)) return false;

            for (var i = 0; i < IgnoredProcessNames.Length; i++)
            {
                if (string.Equals(name, IgnoredProcessNames[i], StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            return false;
        }
        catch
        {
            return false;
        }
    }

    private void Unbind_NoLock()
    {
        try { _cts?.Cancel(); } catch { /* ignore */ }
        _cts?.Dispose();
        _cts = null;
        _idleSince = null;
        _activePids = new HashSet<uint>();

        // Don't Join() on UI thread; just let background thread exit.
        _workerThread = null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            Unbind_NoLock();
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MicrophoneUsageMonitor));
    }
}

