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
        string? triggeringAppName = null)
    {
        IsInUse = isInUse;
        PreviousActiveSessions = previousActiveSessions;
        CurrentActiveSessions = currentActiveSessions;
        TriggeringAppName = triggeringAppName;
    }

    public bool IsInUse { get; }
    public int PreviousActiveSessions { get; }
    public int CurrentActiveSessions { get; }
    public string? TriggeringAppName { get; }
    public bool IsIncrease => CurrentActiveSessions > PreviousActiveSessions;
}

