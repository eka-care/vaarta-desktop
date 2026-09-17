namespace EkaDeskDocHelper.Services;

internal interface IMicrophoneUsageMonitor : IDisposable
{
    void Start();

    event EventHandler<MicrophoneUsageChangedEventArgs>? MicrophoneUsageChanged;
}

internal sealed class MicrophoneUsageChangedEventArgs : EventArgs
{
    public MicrophoneUsageChangedEventArgs(
        bool isInUse,
        int previousActiveSessions,
        int currentActiveSessions,
        string? triggeringAppName = null,
        bool hasNewSession = false)
    {
        IsInUse = isInUse;
        PreviousActiveSessions = previousActiveSessions;
        CurrentActiveSessions = currentActiveSessions;
        TriggeringAppName = triggeringAppName;
        HasNewSession = hasNewSession;
    }

    public bool IsInUse { get; }
    public int PreviousActiveSessions { get; }
    public int CurrentActiveSessions { get; }
    public string? TriggeringAppName { get; }
    /// True when a process started using the mic, even if another stopped in the same poll.
    public bool HasNewSession { get; }
}

