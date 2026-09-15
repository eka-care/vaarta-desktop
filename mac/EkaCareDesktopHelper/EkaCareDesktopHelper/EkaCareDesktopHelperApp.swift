//
//  EkaCareDesktopHelperApp.swift
//  EkaCareDesktopHelper
//
//  Created by Lourdes Dinesh on 3/13/26.
//

import SwiftUI
import AppKit
import Carbon
import ServiceManagement

@main
struct DeskDocOverlayApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
  
  var body: some Scene {
    // No visible SwiftUI scenes; everything is NSPanel-based.
    Settings {
      EmptyView()
    }
  }
}

// Must match OWNER_PID_FILE in src/main/managers/nativeHelperManager.ts.
private let ownerPidFile = "/tmp/deskdoc-pill-owner.vaarta.pid"

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  /// The Electron host app bundle that contains this helper, derived from the
  /// helper's own location (…/<Host>.app/Contents/Resources/native/mac/
  /// EkaCareDesktopHelper.app) so it survives product renames. `nil` in dev
  /// builds, where the helper runs from mac/build/Release with no enclosing
  /// host bundle.
  private static let electronHostAppPath: String? = {
    var url = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent()
    while url.path != "/" {
      if url.pathExtension == "app" { return url.path }
      url.deleteLastPathComponent()
    }
    return nil
  }()

  private let appState = BridgeAppState()
  private let overlayStateStore = OverlayStateStore()
  private let notificationPreferencesStore = OverlayNotificationPreferencesStore()
  private let shortcutPreferencesStore = OverlayShortcutPreferencesStore()
  private let layoutPreferencesStore = OverlayLayoutPreferencesStore()
  private var overlayController: OverlayWindowController?
  private var bridgeClient: NativeBridgeClient?
  private var micMonitor: MacMicrophoneUsageMonitor?
  private var ownerMonitor: OwnerProcessMonitor?
  private var hotKeyMonitor: HotKeyMonitor?
  private var pauseResumeHotKeyMonitor: HotKeyMonitor?
  private var didHandleURLThisActivation = false
  private var hasInitiatedMissingHostCleanup = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    registerForLaunchAtLoginIfNeeded()
    terminateOtherHelperInstances()
    NSApp.setActivationPolicy(.accessory)
    overlayController = OverlayWindowController(
      appState: appState,
      overlayStateStore: overlayStateStore,
      layoutStore: layoutPreferencesStore
    )
    let bridgeConfig = parseBridgeArgs()

    let bridge: NativeBridgeClient
    switch bridgeConfig {
    case .stdio:
      // Capture the raw stdio fds before redirecting fd 1 (stdout) onto fd 2
      // (stderr). After dup2, every existing print(...) flows to the parent's
      // stderr pipe instead of corrupting the binary protocol on stdout.
      let stdinFd = dup(0)
      let stdoutFd = dup(1)
      _ = dup2(2, 1)
      let bridgeIn = FileHandle(fileDescriptor: stdinFd, closeOnDealloc: false)
      let bridgeOut = FileHandle(fileDescriptor: stdoutFd, closeOnDealloc: false)
      FileHandle.standardError.write(Data("[MacHelper] launching with bridge=stdio\n".utf8))
      bridge = NativeBridgeClient(stdioInput: bridgeIn, stdioOutput: bridgeOut)
    case .tcp(let host, let port):
      print("[MacHelper] launching with bridge host=\(host) port=\(port)")
      bridge = NativeBridgeClient(host: host, port: port)
    }
    bridge.onEvent = { [weak self] name, payload in
      Task { @MainActor [weak self] in
        self?.appState.handleBridgeEvent(name: name, payload: payload)
      }
    }
    bridge.onRequest = { [weak self] name, payload in
      DispatchQueue.main.sync { [weak self] in
        guard let self else { return nil }
        return self.handleElectronRequest(name: name, payload: payload)
      }
    }
    bridge.start()
    bridgeClient = bridge

    notificationPreferencesStore.onChange = { [weak self] prefs in
      Task { @MainActor [weak self] in
        self?.appState.applyNotificationPreferences(prefs)
      }
    }

    let monitor = MacMicrophoneUsageMonitor()
    monitor.onUsersChanged = { [weak self] current, added in
      Task { @MainActor [weak self] in
        self?.appState.handleMicUsersChanged(current: current, added: added)
      }
    }
    monitor.start()
    micMonitor = monitor

    appState.configure(
      bridgeClient: bridge,
      overlayStateStore: overlayStateStore,
      notificationPreferences: notificationPreferencesStore.current,
      canPresentPromptOverlay: { [weak self] in
        self?.validateEkaScribeHostAppBeforePrompt() ?? false
      }
    )
    appState.refreshOverlayVisibility()

    let hotKeyMonitor = HotKeyMonitor()
    hotKeyMonitor.onHotKeyPressed = { [weak self] in
      Task { @MainActor [weak self] in
        self?.appState.recordingShortcutTapped()
      }
    }
    hotKeyMonitor.applyPreferences(shortcutPreferencesStore.current)
    self.hotKeyMonitor = hotKeyMonitor

    let pauseResumeHotKeyMonitor = HotKeyMonitor(signature: "DDPK", id: 2)
    pauseResumeHotKeyMonitor.onHotKeyPressed = { [weak self] in
      Task { @MainActor [weak self] in
        self?.appState.pauseResumeShortcutTapped()
      }
    }
    pauseResumeHotKeyMonitor.applyFixedShortcut("Ctrl + P")
    self.pauseResumeHotKeyMonitor = pauseResumeHotKeyMonitor

    shortcutPreferencesStore.onChange = { [weak hotKeyMonitor] prefs in
      Task { @MainActor [weak hotKeyMonitor] in
        print("[MacHelper] shortcut prefs applied enabled=\(prefs.enabled) shortcut=\(prefs.shortcut)")
        hotKeyMonitor?.applyPreferences(prefs)
      }
    }

    let owner = OwnerProcessMonitor(ownerPidFilePath: ownerPidFile)
    owner.onOwnerMissing = { [weak self] in
      DispatchQueue.main.async { [weak self] in
        self?.overlayController?.hide()
        NSApp.terminate(nil)
      }
    }
    owner.start()
    ownerMonitor = owner
  }

  private func terminateOtherHelperInstances() {
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      return
    }

    let currentProcessIdentifier = ProcessInfo.processInfo.processIdentifier
    let siblingInstances = NSRunningApplication
      .runningApplications(withBundleIdentifier: bundleIdentifier)
      .filter { $0.processIdentifier != currentProcessIdentifier }

    for instance in siblingInstances {
      let terminated = instance.forceTerminate()
      print("[MacHelper] terminated older instance pid=\(instance.processIdentifier) success=\(terminated)")
    }
  }

  private func registerForLaunchAtLoginIfNeeded() {
    guard #available(macOS 13.0, *) else {
      print("[MacHelper] launch at login requires macOS 13 or later")
      return
    }

    do {
      try SMAppService.mainApp.register()
      print("[MacHelper] launch at login registered")
    } catch let error as NSError {
      if error.code == Int(kSMErrorAlreadyRegistered) {
        print("[MacHelper] launch at login already registered")
        return
      }

      print("[MacHelper] failed to register launch at login: \(error)")
    }
  }

  private func validateEkaScribeHostAppBeforePrompt() -> Bool {
    guard !hasInitiatedMissingHostCleanup else { return false }
    guard let hostAppPath = Self.electronHostAppPath else {
      return true
    }
    let appExists = FileManager.default.fileExists(atPath: hostAppPath)
    guard appExists else {
      handleMissingEkaScribeApp()
      return false
    }
    return true
  }

  private func handleMissingEkaScribeApp() {
    guard !hasInitiatedMissingHostCleanup else { return }
    hasInitiatedMissingHostCleanup = true
    print("[MacHelper] host app missing at \(Self.electronHostAppPath ?? "<unknown>"); removing login item and terminating helper")
    removeFromLoginItemsIfRegistered()
    overlayController?.hide()
    NSApp.terminate(nil)
  }

  private func removeFromLoginItemsIfRegistered() {
    guard #available(macOS 13.0, *) else {
      return
    }

    do {
      try SMAppService.mainApp.unregister()
      print("[MacHelper] launch at login unregistered")
    } catch {
      print("[MacHelper] failed to unregister launch at login: \(error)")
    }
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where url.scheme == "deskdoc-pill" {
      didHandleURLThisActivation = true
      overlayController?.toggle()
      break
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    if didHandleURLThisActivation {
      didHandleURLThisActivation = false
      return
    }
    appState.refreshOverlayVisibility()
  }

  func applicationWillTerminate(_ notification: Notification) {
    bridgeClient?.stop()
    micMonitor?.stop()
    ownerMonitor?.stop()
    hotKeyMonitor?.stop()
    pauseResumeHotKeyMonitor?.stop()
    overlayController?.hide()
    overlayController = nil
  }

  /// Handles inbound Electron `request` frames. Returns a JSON-serializable
  /// dictionary on success, or `nil` to send an error response.
  private func handleElectronRequest(name: String, payload: [String: Any]) -> [String: Any]? {
    switch name {
    case "overlay.notificationPrefs.get":
      let prefs = notificationPreferencesStore.current
      print("[MacHelper] <- request \(name) -> \(prefs.asDictionary())")
      return prefs.asDictionary()
    case "overlay.notificationPrefs.update":
      let updated = notificationPreferencesStore.update(payload)
      print("[MacHelper] <- request \(name) payload=\(payload) -> \(updated.asDictionary())")
      return updated.asDictionary()
    case "overlay.shortcut.get":
      let prefs = shortcutPreferencesStore.current
      print("[MacHelper] <- request \(name) -> \(prefs.asDictionary())")
      return prefs.asDictionary()
    case "overlay.shortcut.update":
      let updated = shortcutPreferencesStore.update(payload)
      print("[MacHelper] <- request \(name) payload=\(payload) -> \(updated.asDictionary())")
      return updated.asDictionary()
    default:
      print("[MacHelper] <- request \(name) unhandled")
      return nil
    }
  }

  private enum BridgeConfig {
    case stdio
    case tcp(host: String, port: Int)
  }

  private func parseBridgeArgs() -> BridgeConfig {
    var host = "127.0.0.1"
    var port = 50505
    var stdioRequested = false
    for arg in CommandLine.arguments {
      if arg == "--bridge-stdio" {
        stdioRequested = true
      } else if arg.hasPrefix("--bridge-host=") {
        host = String(arg.dropFirst("--bridge-host=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
      } else if arg.hasPrefix("--bridge-port=") {
        let raw = String(arg.dropFirst("--bridge-port=".count))
        if let parsedPort = Int(raw), parsedPort > 0, parsedPort <= Int(UInt16.max) {
          port = parsedPort
        }
      }
    }
    if stdioRequested { return .stdio }
    return .tcp(host: host, port: port)
  }
}

private final class HotKeyMonitor {
  /// Invoked when the currently-registered shortcut fires. Runs on an
  /// unspecified queue; hop to the main actor for UI/state work.
  var onHotKeyPressed: (() -> Void)?

  private var eventHandler: EventHandlerRef?
  private var hotKeyRef: EventHotKeyRef?
  private var activeBinding: ShortcutBinding?
  private let hotKeyID: EventHotKeyID

  init(signature: String = "DDHK", id: UInt32 = 1) {
    hotKeyID = EventHotKeyID(signature: fourCharCode(signature), id: id)
  }

  func applyPreferences(_ prefs: OverlayShortcutPreferences) {
    unregisterHotKey()

    guard prefs.enabled else {
      print("[MacHelper] quick access shortcut disabled; skipping registration")
      // Keep the event handler installed so a future enable can reuse it cheaply.
      return
    }

    let resolved = ShortcutBindingParser.parse(prefs.shortcut)
      ?? ShortcutBindingParser.parse(OverlayShortcutPreferences.defaultShortcut)
    guard let binding = resolved else {
      print("[MacHelper] failed to parse shortcut='\(prefs.shortcut)' and default fallback")
      return
    }

    ensureEventHandlerInstalled()
    registerHotKey(binding: binding)
  }

  func applyFixedShortcut(_ shortcut: String) {
    unregisterHotKey()

    guard let binding = ShortcutBindingParser.parse(shortcut) else {
      print("[MacHelper] failed to parse fixed shortcut='\(shortcut)'")
      return
    }

    ensureEventHandlerInstalled()
    registerHotKey(binding: binding)
  }

  func stop() {
    unregisterHotKey()
    if let eventHandler {
      RemoveEventHandler(eventHandler)
      self.eventHandler = nil
    }
  }

  private func ensureEventHandlerInstalled() {
    guard eventHandler == nil else { return }

    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: OSType(kEventHotKeyPressed)
    )

    let handlerStatus = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, userData in
        guard let event, let userData else { return noErr }
        let monitor = Unmanaged<HotKeyMonitor>.fromOpaque(userData).takeUnretainedValue()
        return monitor.handleHotKeyPressed(event)
      },
      1,
      &eventType,
      Unmanaged.passUnretained(self).toOpaque(),
      &eventHandler
    )

    if handlerStatus != noErr {
      print("[MacHelper] failed to install hotkey handler status=\(handlerStatus)")
      eventHandler = nil
    }
  }

  private func registerHotKey(binding: ShortcutBinding) {
    let registerStatus = RegisterEventHotKey(
      binding.keyCode,
      binding.modifiers,
      hotKeyID,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )

    if registerStatus == noErr {
      activeBinding = binding
      print("[MacHelper] registered hotkey \(binding.normalizedDisplay)")
    } else {
      print("[MacHelper] failed to register hotkey \(binding.normalizedDisplay) status=\(registerStatus)")
      hotKeyRef = nil
      activeBinding = nil
    }
  }

  private func unregisterHotKey() {
    if let hotKeyRef {
      UnregisterEventHotKey(hotKeyRef)
      self.hotKeyRef = nil
      if let activeBinding {
        print("[MacHelper] unregistered hotkey \(activeBinding.normalizedDisplay)")
      }
    }
    activeBinding = nil
  }

  private func handleHotKeyPressed(_ event: EventRef) -> OSStatus {
    var resolvedHotKeyID = EventHotKeyID()
    let status = GetEventParameter(
      event,
      EventParamName(kEventParamDirectObject),
      EventParamType(typeEventHotKeyID),
      nil,
      MemoryLayout<EventHotKeyID>.size,
      nil,
      &resolvedHotKeyID
    )

    guard status == noErr else {
      print("[MacHelper] failed to read hotkey event status=\(status)")
      return status
    }

    guard resolvedHotKeyID.signature == hotKeyID.signature, resolvedHotKeyID.id == hotKeyID.id else {
      return noErr
    }

    onHotKeyPressed?()
    return noErr
  }
}

private func fourCharCode(_ value: String) -> OSType {
  value.utf8.reduce(0) { partialResult, byte in
    (partialResult << 8) + OSType(byte)
  }
}
