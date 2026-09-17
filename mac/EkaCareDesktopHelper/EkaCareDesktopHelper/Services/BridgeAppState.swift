import Foundation
import Combine
import AppKit

// MARK: - Public phase enum

enum ScribePhase: Equatable {
  case idle
  case recording(isPaused: Bool)
  case processing
  case error(message: String?)
  case completed(transactionId: String?)
}

// MARK: - Internal parsing types

private enum ScribeStatus: String {
  case ready = "READY"
  case recording = "RECORDING"
  case recordingPaused = "RECORDING_PAUSED"
  case initializing = "INITIALIZING"
  case analyzing = "ANALYZING"
  case recordingStopped = "RECORDING_STOPPED"
  case outputGenerated = "OUTPUT_GENERATED"
  case analyzingFailed = "ANALYZING_FAILED"
  case notStarted = "NOT_STARTED"
  case paused = "PAUSED"
}

private struct ScribeStatusSnapshot {
  let status: ScribeStatus
  let sessionId: String
  let hasPendingStartCommand: Bool
  let pendingStartCommandCount: Int
}

// MARK: - BridgeAppState

@MainActor
final class BridgeAppState: ObservableObject {
  private static let processingTimeoutSeconds: TimeInterval = 120 // 2 minutes
  private static let nativeEventCooldownNs: TimeInterval = 0.6
  private static let shortcutStopDebounceSeconds: TimeInterval = 5
  private static let startRecordingDeepLink = "ekadoc://recording?command=start-recording&source=overlay"
  private static let scribeResultDeepLink = "ekadoc://"
  /// Matches `build.appId` in the root `package.json` (electron-builder).
  private static let electronHostBundleIdentifier = "care.eka.vaarta"

  @Published private(set) var phase: ScribePhase = .idle
  @Published private(set) var sessionId: String = ""

  private var bridgeClient: NativeBridgeClient?
  private weak var overlayStateStore: OverlayStateStore?
  private var hasPendingStartCommand = false
  private var pendingStartCommandCount = 0
  private var isElectronFocused: Bool = false
  private var isMicInUse = false
  /// Apps dismissed for; cleared per-app on mic release. "" means app unresolved.
  private var dismissedApps: Set<String> = []
  private var micUsers: Set<MicUser> = []
  private var processingTimer: DispatchSourceTimer?
  private var lastStartSentAt = Date.distantPast
  private var lastPauseToggleSentAt = Date.distantPast
  private var lastStopSentAt = Date.distantPast
  private var shortcutRecordingStartedAt: Date?
  private var notificationPreferences: OverlayNotificationPreferences = .defaults
  private var canPresentPromptOverlay: (() -> Bool)?
  private(set) var triggeringAppName: String?

  func configure(
    bridgeClient: NativeBridgeClient,
    overlayStateStore: OverlayStateStore,
    notificationPreferences: OverlayNotificationPreferences,
    canPresentPromptOverlay: @escaping () -> Bool
  ) {
    self.bridgeClient = bridgeClient
    self.overlayStateStore = overlayStateStore
    self.notificationPreferences = notificationPreferences
    self.canPresentPromptOverlay = canPresentPromptOverlay
  }

  func applyNotificationPreferences(_ prefs: OverlayNotificationPreferences) {
    notificationPreferences = prefs
    print("[MacHelper] overlay notification prefs applied \(prefs.asDictionary())")
    refreshOverlayVisibility()
  }

  func handleElectronFocusChanged(isFocused: Bool) {
    isElectronFocused = isFocused
    if isFocused {
      // Consume terminal state — user is already looking at the Electron app.
      switch phase {
      case .error, .completed:
        phase = .idle
      default:
        break
      }
    }
    refreshOverlayVisibility()
  }

  func handleBridgeEvent(name: String, payload: [String: Any]) {
    print("[MacHelper] <- event \(name) payload=\(payload)")
    switch name {
    case "scribe.status":
      let raw = String(describing: payload["processingStatus"] ?? "")
      let newSessionId = String(describing: payload["sessionId"] ?? "")
      sessionId = newSessionId
      let normalized = Self.normalizeScribeStatus(raw)
      switch normalized {
      case .recording:
        phase = .recording(isPaused: false)
      case .recordingPaused, .paused:
        phase = .recording(isPaused: true)
      case .analyzing, .initializing:
        phase = .processing
      case .analyzingFailed:
        setTerminalPhase(.error(message: nil))
        return
      case .outputGenerated:
        setTerminalPhase(.completed(transactionId: nil))
        return
      case .ready, .notStarted:
        // Only reset to idle if currently recording — web sends READY on discard.
        // Processing and terminal states are authoritative; ignore stale READY.
        switch phase {
        case .recording:
          phase = .idle
        default:
          break
        }
      case .recordingStopped:
        // Recording stopped acknowledgement — transition to processing if we were recording.
        switch phase {
        case .recording:
          phase = .processing
        default:
          break
        }
      }
      if case .recording = phase { } else { shortcutRecordingStartedAt = nil }
      refreshOverlayVisibility()

    case "scribe.processing.completed":
      let txId = payload["transactionId"] as? String
      setTerminalPhase(.completed(transactionId: txId?.isEmpty == false ? txId : nil))

    case "scribe.error":
      let msg = payload["errorMessage"] as? String
      setTerminalPhase(.error(message: msg))

    case "app.focus.changed":
      let isFocused = payload["isFocused"] as? Bool ?? false
      if payload["isFocused"] == nil {
        print("[MacHelper] app.focus.changed payload missing 'isFocused' field, defaulting to false")
      }
      handleElectronFocusChanged(isFocused: isFocused)

    case "scribe.session.discarded":
      phase = .idle
      overlayStateStore?.set(.hidden, source: "session-discarded")

    case "bridge.reconnect":
      // Stdio transport has no socket to redial; the parent owns lifecycle.
      if bridgeClient?.isStdioTransport == true { break }
      Task { @MainActor [weak self] in
        await self?.bridgeClient?.restart()
      }

    default:
      break
    }
  }

  func startRecordingTapped() {
    defer {
      // Dismiss the prompt overlay immediately on Start.
      dismissOverlayPrompt()
    }

    if Date().timeIntervalSince(lastStartSentAt) < Self.nativeEventCooldownNs {
      print("[MacHelper] skipping duplicate start click")
      return
    }
    lastStartSentAt = Date()

    if bridgeClient?.isConnected == true {
      Task { @MainActor [weak self] in
        guard let self else { return }
        let sent = await bridgeClient?.sendEventWithResult(name: "recording.start", payload: nil) ?? false
        if sent {
          print("[MacHelper] -> event recording.start")
        } else {
          print("[MacHelper] bridge send failed for recording.start; falling back to deep link")
          openStartRecordingDeepLink()
        }
      }
      return
    }

    openStartRecordingDeepLink()
  }

  func recordingShortcutTapped() {
    if case .recording = phase {
      if let startedAt = shortcutRecordingStartedAt,
         Date().timeIntervalSince(startedAt) < Self.shortcutStopDebounceSeconds {
        print("[MacHelper] ignoring shortcut stop within debounce window")
        return
      }
      shortcutRecordingStartedAt = nil
      stopRecordingTapped()
      return
    }
    shortcutRecordingStartedAt = Date()
    startRecordingTapped()
  }

  func pauseResumeShortcutTapped() {
    guard case .recording(let isPaused) = phase else { return }
    if isPaused {
      resumeRecording()
    } else {
      pauseRecording()
    }
  }

  func dismissOverlayPrompt() {
    // Terminal and processing states go back to idle when dismissed (timer or X button).
    // Processing is included so that a user-closed processing overlay doesn't re-appear
    // on the next refreshOverlayVisibility() call while the phase is still .processing.
    switch phase {
    case .idle:
      dismissedApps.insert(Self.normalizedPromptAppName(triggeringAppName) ?? "")
    case .error, .completed, .processing:
      phase = .idle
    default:
      break
    }
    overlayStateStore?.set(.hidden, source: "overlay-ui")
  }

  func viewErrorTapped() {
    phase = .idle
    overlayStateStore?.set(.hidden, source: "overlay-ui")
    activateElectronHostAppIfBackground()
    openScribeResultDeepLink(transactionId: nil)
  }

  func stopRecordingTapped() {
    if Date().timeIntervalSince(lastStopSentAt) < Self.nativeEventCooldownNs {
      print("[MacHelper] skipping duplicate stop click")
      return
    }
    lastStopSentAt = Date()
    Task { @MainActor [weak self] in
      guard let self else { return }
      await bridgeClient?.sendEvent(name: "recording.stop", payload: nil)
      print("[MacHelper] -> event recording.stop")
    }
  }

  func pauseRecording() {
    if Date().timeIntervalSince(lastPauseToggleSentAt) < Self.nativeEventCooldownNs {
      print("[MacHelper] skipping duplicate pause click")
      return
    }
    lastPauseToggleSentAt = Date()
    Task { @MainActor [weak self] in
      guard let self else { return }
      await bridgeClient?.sendEvent(name: "recording.pause", payload: nil)
      print("[MacHelper] -> event recording.pause")
    }
  }

  func resumeRecording() {
    if Date().timeIntervalSince(lastPauseToggleSentAt) < Self.nativeEventCooldownNs {
      print("[MacHelper] skipping duplicate resume click")
      return
    }
    lastPauseToggleSentAt = Date()
    Task { @MainActor [weak self] in
      guard let self else { return }
      await bridgeClient?.sendEvent(name: "recording.resume", payload: nil)
      print("[MacHelper] -> event recording.resume")
    }
  }

  func emitScribeResultView(transactionId: String?) {
    phase = .idle
    overlayStateStore?.set(.hidden, source: "overlay-ui")
    activateElectronHostAppIfBackground()
    openScribeResultDeepLink(transactionId: transactionId)
    Task { @MainActor [weak self] in
      guard let self else { return }
      let payload: [String: Any?] = ["transactionId": transactionId]
      await bridgeClient?.sendEvent(name: "scribe.result.view", payload: payload)
      print("[MacHelper] -> event scribe.result.view transactionId=\(transactionId ?? "nil")")
    }
  }

  /// Logo tapped on the floating overlay — bring the Electron host app to the
  /// front. Activates the running app immediately and also notifies Electron
  /// over the bridge so it can restore/focus its main window.
  func openMainAppTapped() {
    activateElectronHostAppIfBackground()
    Task { @MainActor [weak self] in
      guard let self else { return }
      await bridgeClient?.sendEvent(name: "overlay.open.app", payload: nil)
      print("[MacHelper] -> event overlay.open.app")
    }
  }

  func handleMicUsersChanged(current: Set<MicUser>, added: Set<MicUser>) {
    let wasInUse = isMicInUse
    micUsers = current
    let inUse = !current.isEmpty
    isMicInUse = inUse

    let liveNames = Set(current.compactMap { Self.normalizedPromptAppName($0.displayName) })
    dismissedApps = dismissedApps.filter { $0.isEmpty ? inUse : liveNames.contains($0) }

    if inUse {
      if !wasInUse {
        // fresh mic session — drop stale pending-start from the previous one
        hasPendingStartCommand = false
        pendingStartCommandCount = 0
      }
      if case .recording = phase {
        // keep the prompt app fixed mid-session
      } else if let newcomer = Self.arrivingTrigger(from: added) {
        triggeringAppName = newcomer.displayName
      } else if triggeringAppName == nil
                  || !current.contains(where: { $0.displayName == triggeringAppName }) {
        triggeringAppName = Self.fallbackTrigger(from: current)?.displayName
      }
    } else {
      triggeringAppName = nil
      dismissedApps.removeAll()
    }
    // Reflect microphone-edge changes immediately.
    refreshOverlayVisibility()
    if inUse != wasInUse {
      let payload: [String: Any] = ["isInUse": inUse, "source": "microphone"]
      Task { @MainActor [weak self] in
        guard let self else { return }
        await bridgeClient?.sendEvent(name: "microphone.usage.changed", payload: payload)
        print("[MacHelper] -> event microphone.usage.changed isInUse=\(inUse)")
      }
    }

    if inUse {
      guard !added.isEmpty else { return }
      Task { @MainActor [weak self] in
        guard let self else { return }
        let snapshot = await fetchScribeStatus()
        guard let snapshot else {
          refreshOverlayVisibility()
          return
        }
        let shouldIgnoreStalePendingStart =
          isMicInUse
          && !isElectronHostAppRunning()
          && snapshot.status == .notStarted
          && snapshot.hasPendingStartCommand
        // Only update from snapshot if mic is still in use (guards against async race
        // where a bridge event changed phase while the fetch was in flight).
        guard isMicInUse else { return }
        // Don't override authoritative terminal/processing phases.
        switch phase {
        case .processing, .error, .completed:
          break
        default:
          phase = Self.phaseFromStatus(snapshot.status)
        }
        sessionId = snapshot.sessionId
        if shouldIgnoreStalePendingStart {
          hasPendingStartCommand = false
          pendingStartCommandCount = 0
          print("[MacHelper] ignoring stale pending start status because Electron host is not running")
        } else {
          hasPendingStartCommand = snapshot.hasPendingStartCommand
          pendingStartCommandCount = snapshot.pendingStartCommandCount
        }
        refreshOverlayVisibility()
      }
      return
    }

    guard wasInUse else { return }

    // Third-party mic released — stop if we're trying to record.
    let weAreTryingToRecord: Bool = {
      if case .recording = phase { return true }
      return false
    }() || hasPendingStartCommand
    if weAreTryingToRecord {
      stopRecordingTapped()
    }
    hasPendingStartCommand = false
    pendingStartCommandCount = 0
    refreshOverlayVisibility()
  }

  func refreshOverlayVisibility() {
    let prefs = notificationPreferences
    var next: OverlayPresentation

    switch phase {
    case .idle:
      let canPrompt = isMicInUse
        && !hasPendingStartCommand
        && !isPromptDismissedForCurrentApp()
        && (canPresentPromptOverlay?() ?? true)
        && !DisabledAppsPreferencesStore.shared.isDisabled(triggeringAppName ?? "")
        // triggeringAppName is frozen during a session, so it may name an app that has left.
        && micUsers.contains { $0.displayName == triggeringAppName }
      next = canPrompt ? .prompt : .hidden
    case .recording:
      next = .recording
    case .processing:
      next = .processing
    case .error(let message):
      next = .error(message: message)
    case .completed(let transactionId):
      next = .processed(transactionId: transactionId)
    }

    // Apply user notification preferences.
    if case .prompt = next, !prefs.joinVideoConferencingAndStartTranscribing { next = .hidden }
    if case .recording = next, !prefs.meetingIsBeingRecorded { next = .hidden }

    // Focus only suppresses active scribe overlays; prompt visibility is independent.
    if isElectronFocused {
      switch next {
      case .recording, .processing, .processed, .error:
        next = .hidden
      case .prompt, .hidden:
        break
      }
    }

    print(
      "[MacHelper] overlay visibility phase=\(phase) mic=\(isMicInUse) focused=\(isElectronFocused) pendingStart=\(hasPendingStartCommand) next=\(next)"
    )
    if case .prompt = next {
      overlayStateStore?.setPrompt(appName: triggeringAppName, source: "bridge-app-state")
    } else {
      overlayStateStore?.set(next, source: "bridge-app-state")
    }
    manageProcessingTimeout()
  }

  // MARK: - Private helpers

  /// Disabled arrivals never re-target, so they can't hide a live prompt.
  private static func arrivingTrigger(from users: Set<MicUser>) -> MicUser? {
    users.sorted { $0.id < $1.id }
      .first { !DisabledAppsPreferencesStore.shared.isDisabled($0.displayName) }
  }

  /// Falls back to a disabled app, not nil — the name is what suppresses the prompt.
  private static func fallbackTrigger(from users: Set<MicUser>) -> MicUser? {
    let sorted = users.sorted { $0.id < $1.id }
    return sorted.first { !DisabledAppsPreferencesStore.shared.isDisabled($0.displayName) }
      ?? sorted.first
  }

  private static func normalizedPromptAppName(_ name: String?) -> String? {
    guard let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed.lowercased()
  }

  private func isPromptDismissedForCurrentApp() -> Bool {
    if dismissedApps.isEmpty { return false }
    // Dismissed before we resolved the triggering app — suppress until mic release.
    if dismissedApps.contains("") { return true }
    guard let current = Self.normalizedPromptAppName(triggeringAppName) else { return true }
    return dismissedApps.contains(current)
  }

  private func manageProcessingTimeout() {
    processingTimer?.cancel()
    processingTimer = nil
    guard case .processing = phase else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + Self.processingTimeoutSeconds)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      guard case .processing = self.phase else { return }
      print("[MacHelper] processing phase auto-reset after \(Self.processingTimeoutSeconds)s timeout")
      self.phase = .idle
      self.refreshOverlayVisibility()
    }
    timer.resume()
    processingTimer = timer
  }

  private func setTerminalPhase(_ terminal: ScribePhase) {
    // If Electron is in foreground, user already sees the result — no overlay needed.
    phase = isElectronFocused ? .idle : terminal
    refreshOverlayVisibility()
  }

  private func fetchScribeStatus() async -> ScribeStatusSnapshot? {
    guard let bridgeClient else { return nil }
    let response = await bridgeClient.request(name: "scribe.getStatus", payload: nil, timeoutMs: 2500)
    guard let responseDict = response as? [String: Any] else {
      return nil
    }

    let raw = String(describing: responseDict["processingStatus"] ?? "")
    let status = Self.normalizeScribeStatus(raw)
    let incomingSessionId = String(describing: responseDict["sessionId"] ?? "")
    let pending = responseDict["hasPendingStartCommand"] as? Bool ?? false
    let pendingCount = responseDict["pendingStartCommandCount"] as? Int ?? 0
    print("[MacHelper] <- response scribe.getStatus \(responseDict)")
    return .init(
      status: status,
      sessionId: incomingSessionId,
      hasPendingStartCommand: pending,
      pendingStartCommandCount: pendingCount
    )
  }

  private static func phaseFromStatus(_ status: ScribeStatus) -> ScribePhase {
    switch status {
    case .recording, .recordingStopped: return .recording(isPaused: false)
    case .recordingPaused, .paused: return .recording(isPaused: true)
    case .analyzing, .initializing: return .processing
    case .analyzingFailed: return .error(message: nil)
    case .outputGenerated: return .completed(transactionId: nil)
    default: return .idle
    }
  }

  private static func normalizeScribeStatus(_ raw: String) -> ScribeStatus {
    let key = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased().replacingOccurrences(of: "-", with: "_")
    switch key {
    case "NOT_STARTED":
      return .notStarted
    case "READY":
      return .ready
    case "PAUSED", "RECORDING_PAUSED":
      return .recordingPaused
    case "RECORDING", "RECORDING_STARTED", "STARTED", "IN_PROGRESS", "RUNNING", "RESUME", "RECORDING_RESUMED":
      return .recording
    case "RECORDING_STOPPED":
      return .recordingStopped
    case "ANALYZING", "ANALYSING", "PROCESSING":
      return .analyzing
    case "OUTPUT_GENERATED":
      return .outputGenerated
    case "ANALYZING_FAILED":
      return .analyzingFailed
    case "INITIALIZING":
      return .initializing
    default:
      return .ready
    }
  }

  private func openStartRecordingDeepLink() {
    guard let deepLinkURL = URL(string: Self.startRecordingDeepLink) else {
      print("[MacHelper] failed to trigger recording start: invalid deep link")
      return
    }
    let opened = NSWorkspace.shared.open(deepLinkURL)
    if !opened {
      print("[MacHelper] failed to trigger recording start: deep link open returned false")
    }
  }

  private func activateElectronHostAppIfBackground() {
    let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: Self.electronHostBundleIdentifier)
    guard let app = candidates.first(where: { !$0.isTerminated }) else { return }
    guard !app.isActive else { return }
    let ok: Bool
    if #available(macOS 14.0, *) {
      ok = app.activate(options: [.activateAllWindows])
    } else {
      ok = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }
    if !ok {
      print("[MacHelper] activate Electron host failed bid=\(Self.electronHostBundleIdentifier)")
    }
  }

  private func isElectronHostAppRunning() -> Bool {
    NSRunningApplication
      .runningApplications(withBundleIdentifier: Self.electronHostBundleIdentifier)
      .contains(where: { !$0.isTerminated })
  }

  private func openScribeResultDeepLink(transactionId: String?) {
    guard let deepLinkURL = URL(string: Self.scribeResultDeepLink) else {
      print("[MacHelper] failed to open scribe result: invalid deep link transactionId=\(transactionId ?? "nil")")
      return
    }
    let opened = NSWorkspace.shared.open(deepLinkURL)
    if !opened {
      print("[MacHelper] failed to open scribe result: deep link open returned false transactionId=\(transactionId ?? "nil")")
    }
  }
}
