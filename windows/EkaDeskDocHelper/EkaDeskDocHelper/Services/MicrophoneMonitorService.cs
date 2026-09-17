using System;
using System.Threading;
using System.Threading.Tasks;

namespace EkaDeskDocHelper.Services;

internal sealed class MicrophoneMonitorService : IDisposable
{
    private static readonly TimeSpan RecordingCommandDebounce = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan StartIntentSuppressionTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan PromptDismissalClearDelay = TimeSpan.FromSeconds(2);

    public static MicrophoneMonitorService Instance { get; } = new();

    private IMicrophoneUsageMonitor? _monitor;
    private IElectronBridgeClient? _bridgeClient;
    private IOverlayStateStore? _overlayStateStore;
    private IOverlayNotificationPreferencesStore? _overlayPreferencesStore;
    private readonly object _debounceGate = new();
    private readonly object _startIntentGate = new();
    private CancellationTokenSource? _recordingCommandDebounceCts;
    private bool _suppressMicTransitionsUntilRecording;
    private DateTime _suppressMicTransitionsSetAtUtc;
    private string? _promptDismissedForAppName;
    private CancellationTokenSource? _clearPromptDismissalCts;
    private bool _isInitialized;

    private MicrophoneMonitorService()
    {
    }

    public void Initialize(
        IMicrophoneUsageMonitor monitor,
        IElectronBridgeClient? bridgeClient,
        IOverlayStateStore overlayStateStore,
        IOverlayNotificationPreferencesStore overlayPreferencesStore)
    {
        if (_isInitialized) return;

        _monitor = monitor;
        _bridgeClient = bridgeClient;
        _overlayStateStore = overlayStateStore;
        _overlayPreferencesStore = overlayPreferencesStore;
        _monitor.MicrophoneUsageChanged += OnMicrophoneUsageChanged;
        _isInitialized = true;
    }

    public void Start()
    {
        _monitor?.Start();
    }

    private void OnMicrophoneUsageChanged(object? sender, MicrophoneUsageChangedEventArgs e)
    {
        _ = SendUsageAsync(e);
    }

    public void NotifyStartRequested()
    {
        lock (_startIntentGate)
        {
            _suppressMicTransitionsUntilRecording = true;
            _suppressMicTransitionsSetAtUtc = DateTime.UtcNow;
        }
    }

    public void NotifyPromptDismissed(string? appName = null)
    {
        _promptDismissedForAppName = NormalizePromptAppName(appName ?? _overlayStateStore?.PromptTriggeringApp) ?? string.Empty;
    }

    private async Task SendUsageAsync(MicrophoneUsageChangedEventArgs usage)
    {
        try
        {
            if (_bridgeClient == null)
            {
                return;
            }

            var isRecording = await IsRecordingActiveAsync().ConfigureAwait(false);
            var suppressMicTransitions = ShouldSuppressMicTransitions(isRecording);

            if (!suppressMicTransitions)
            {
                if (!usage.IsInUse)
                {
                    _overlayStateStore?.Set(null, source: "microphone");
                    ScheduleClearPromptDismissal();
                }
                else
                {
                    CancelClearPromptDismissal();
                    MaybeClearDismissalForDifferentApp(usage.TriggeringAppName);
                    if (usage.HasNewSession
                        && !IsPromptDismissedForApp(usage.TriggeringAppName)
                        && await ShouldShowPromptOverlayAsync(usage.TriggeringAppName).ConfigureAwait(false))
                    {
                        _overlayStateStore?.SetPrompt(usage.TriggeringAppName, source: "microphone");
                    }
                }
            }

            await _bridgeClient.SendEventAsync(
                "microphone.usage.changed",
                new
                {
                    isInUse = usage.IsInUse,
                    source = "microphone",
                    previousActiveSessions = usage.PreviousActiveSessions,
                    currentActiveSessions = usage.CurrentActiveSessions,
                },
                CancellationToken.None);

            if (suppressMicTransitions)
            {
                return;
            }

            await ScheduleRecordingCommandAsync(usage, isRecording).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[MicrophoneMonitorService] failed to forward mic usage: {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (_monitor != null)
        {
            _monitor.MicrophoneUsageChanged -= OnMicrophoneUsageChanged;
            _monitor.Dispose();
            _monitor = null;
        }

        _bridgeClient = null;
        _overlayStateStore = null;
        _overlayPreferencesStore = null;
        CancelRecordingCommandDebounce();
        CancelClearPromptDismissal();
        lock (_startIntentGate)
        {
            _suppressMicTransitionsUntilRecording = false;
            _suppressMicTransitionsSetAtUtc = default;
        }
        _promptDismissedForAppName = null;
    }

    private async Task<bool> ShouldShowPromptOverlayAsync(string? appName = null)
    {
        var joinPref = _overlayPreferencesStore?.Current.JoinVideoConferencingAndStartTranscribing ?? true;
        if (!joinPref) return false;

        if (!string.IsNullOrEmpty(appName) && DisabledAppsPreferencesStore.Instance.IsDisabled(appName))
        {
            Console.WriteLine($"[MicrophoneMonitorService] prompt suppressed for disabled app: {appName}");
            return false;
        }

        if (_bridgeClient?.IsConnected != true)
        {
            return true;
        }

        try
        {
            var status = await _bridgeClient.SendRequestAsync(
                "scribe.getStatus",
                payload: null,
                timeout: TimeSpan.FromSeconds(3),
                cancellationToken: CancellationToken.None).ConfigureAwait(false);

            if (!status.HasValue)
            {
                return true;
            }

            var processingStatus = status.Value.TryGetProperty("processingStatus", out var ps)
                ? ps.GetString()
                : null;
            var normalized = processingStatus?.Trim().Replace('-', '_').ToUpperInvariant();
            var hasPendingStart = status.Value.TryGetProperty("hasPendingStartCommand", out var pendingProp)
                && pendingProp.ValueKind == System.Text.Json.JsonValueKind.True;

            return normalized is not ("RECORDING" or "ANALYZING" or "ANALYSING" or "PAUSED" or "RECORDING_PAUSED")
                && !hasPendingStart;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[MicrophoneMonitorService] failed to request scribe.getStatus: {ex.Message}");
            return true;
        }
    }

    private async Task<bool> IsRecordingActiveAsync()
    {
        if (_bridgeClient?.IsConnected != true)
        {
            return _overlayStateStore?.Current == OverlayUiState.Recording;
        }

        try
        {
            var status = await _bridgeClient.SendRequestAsync(
                "scribe.getStatus",
                payload: null,
                timeout: TimeSpan.FromSeconds(3),
                cancellationToken: CancellationToken.None).ConfigureAwait(false);

            if (!status.HasValue || !status.Value.TryGetProperty("processingStatus", out var ps))
            {
                return _overlayStateStore?.Current == OverlayUiState.Recording;
            }

            var normalized = ps.GetString()?.Trim().Replace('-', '_').ToUpperInvariant();
            return normalized is "RECORDING" or "PAUSED" or "RECORDING_PAUSED";
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[MicrophoneMonitorService] failed to request recording status: {ex.Message}");
            return _overlayStateStore?.Current == OverlayUiState.Recording;
        }
    }

    private async Task ScheduleRecordingCommandAsync(MicrophoneUsageChangedEventArgs usage, bool isRecording)
    {
        if (_bridgeClient == null)
        {
            return;
        }

        var commandName = !usage.IsInUse && isRecording
                ? "recording.stop"
                : null;

        if (commandName == null)
        {
            CancelRecordingCommandDebounce();
            return;
        }

        CancellationTokenSource delayCts;
        lock (_debounceGate)
        {
            _recordingCommandDebounceCts?.Cancel();
            _recordingCommandDebounceCts?.Dispose();
            _recordingCommandDebounceCts = new CancellationTokenSource();
            delayCts = _recordingCommandDebounceCts;
        }

        try
        {
            await Task.Delay(RecordingCommandDebounce, delayCts.Token).ConfigureAwait(false);
            if (!await IsRecordingActiveAsync().ConfigureAwait(false))
            {
                return;
            }

            await _bridgeClient.SendEventAsync(commandName, payload: null, CancellationToken.None).ConfigureAwait(false);
        }
        catch (TaskCanceledException)
        {
            // New mic transition arrived before debounce elapsed.
        }
    }

    private void CancelRecordingCommandDebounce()
    {
        lock (_debounceGate)
        {
            _recordingCommandDebounceCts?.Cancel();
            _recordingCommandDebounceCts?.Dispose();
            _recordingCommandDebounceCts = null;
        }
    }

    private bool ShouldSuppressMicTransitions(bool isRecording)
    {
        lock (_startIntentGate)
        {
            if (!_suppressMicTransitionsUntilRecording)
            {
                return false;
            }

            if (isRecording)
            {
                _suppressMicTransitionsUntilRecording = false;
                _suppressMicTransitionsSetAtUtc = default;
                return false;
            }

            if (_suppressMicTransitionsSetAtUtc != default
                && DateTime.UtcNow - _suppressMicTransitionsSetAtUtc >= StartIntentSuppressionTimeout)
            {
                _suppressMicTransitionsUntilRecording = false;
                _suppressMicTransitionsSetAtUtc = default;
                return false;
            }

            return true;
        }
    }

    private static string? NormalizePromptAppName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        return name.Trim().ToLowerInvariant();
    }

    private bool IsPromptDismissedForApp(string? appName)
    {
        if (string.IsNullOrEmpty(_promptDismissedForAppName)) return false;
        var current = NormalizePromptAppName(appName);
        if (current == null) return true;
        return _promptDismissedForAppName == current;
    }

    private void MaybeClearDismissalForDifferentApp(string? appName)
    {
        var current = NormalizePromptAppName(appName);
        if (current == null || string.IsNullOrEmpty(_promptDismissedForAppName)) return;
        if (current != _promptDismissedForAppName)
        {
            _promptDismissedForAppName = null;
        }
    }

    private void ScheduleClearPromptDismissal()
    {
        CancelClearPromptDismissal();
        _clearPromptDismissalCts = new CancellationTokenSource();
        var cts = _clearPromptDismissalCts;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(PromptDismissalClearDelay, cts.Token).ConfigureAwait(false);
                _promptDismissedForAppName = null;
            }
            catch (TaskCanceledException)
            {
                // Mic became active again before the dismissal window expired.
            }
        });
    }

    private void CancelClearPromptDismissal()
    {
        _clearPromptDismissalCts?.Cancel();
        _clearPromptDismissalCts?.Dispose();
        _clearPromptDismissalCts = null;
    }
}
