//
//  OverlayWindowController.swift
//  EkaCareDesktopHelper
//
//  Created by Lourdes Dinesh on 3/13/26.
//

import AppKit
import SwiftUI
import Combine

private final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool {
    true
  }

  override var canBecomeMain: Bool {
    true
  }
}

final class OverlayWindowController: NSWindowController {
  private let closeButtonOverflow: CGFloat = 9
  private let appState: BridgeAppState
  private let overlayStateStore: OverlayStateStore
  private let layoutStore: OverlayLayoutPreferencesStore
  private var cancellables = Set<AnyCancellable>()
  private let topPadding: CGFloat
  private static let rightPadding: CGFloat = 16

  init(
    appState: BridgeAppState,
    overlayStateStore: OverlayStateStore,
    layoutStore: OverlayLayoutPreferencesStore
  ) {
    self.appState = appState
    self.overlayStateStore = overlayStateStore
    self.layoutStore = layoutStore
    let screen = NSScreen.main
    let panelHeight: CGFloat = 160
    self.topPadding = if let screen, screen.safeAreaInsets.top > 0 {
      32
    } else {
      16
    }

    let frame: NSRect
    if let screen = screen {
      frame = NSRect(
        x: screen.frame.minX,
        y: screen.frame.maxY - panelHeight,
        width: screen.frame.width,
        height: panelHeight
      )
    } else {
      frame = NSRect(x: 0, y: 440, width: 800, height: panelHeight)
    }

    let panel = OverlayPanel(
      contentRect: frame,
      styleMask: [
        .nonactivatingPanel,
        .borderless
      ],
      backing: .buffered,
      defer: false
    )

    panel.level = .statusBar          // above normal windows, under alerts
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true            // drop shadow improves overlay visibility
    panel.hidesOnDeactivate = false
    panel.ignoresMouseEvents = false
    panel.isMovableByWindowBackground = false
    panel.collectionBehavior = [
      .canJoinAllSpaces,
      .fullScreenAuxiliary,
      .transient
    ]

    let rootView = AnyView(
      OverlayContentView()
        .environmentObject(appState)
        .environmentObject(overlayStateStore)
        .environmentObject(layoutStore)
    )
    let hosting = NSHostingView(rootView: rootView)
    hosting.frame = NSRect(origin: .zero, size: frame.size)
    hosting.autoresizingMask = [.width, .height]
    panel.contentView = hosting

    super.init(window: panel)
    bindPresentationState()
    bindLayoutChanges()
    observeScreenChanges()
  }

  init() {
    fatalError("Use init(appState:overlayStateStore:layoutStore:)")
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func show() {
    guard let window = self.window else { return }
    window.orderFrontRegardless()
  }

  func hide() {
    window?.orderOut(nil)
  }

  func toggle() {
    guard let window = self.window else { return }
    if window.isVisible {
      window.orderOut(nil)
    } else {
      window.orderFrontRegardless()
    }
  }

  private func bindPresentationState() {
    overlayStateStore.$presentation
      .receive(on: DispatchQueue.main)
      .sink { [weak self] presentation in
        guard let self else { return }
        if presentation == .hidden {
          hide()
        } else {
          updateWindowFrame(for: presentation)
          show()
        }
      }
      .store(in: &cancellables)
  }

  /// Re-apply the window frame when the persisted layout changes (orientation
  /// flip resizes the recording widget; drag end re-anchors the top-left).
  private func bindLayoutChanges() {
    layoutStore.$current
      .receive(on: DispatchQueue.main)
      .dropFirst()
      .sink { [weak self] _ in
        guard let self else { return }
        let presentation = overlayStateStore.presentation
        guard presentation != .hidden else { return }
        updateWindowFrame(for: presentation)
      }
      .store(in: &cancellables)
  }

  /// Keep the overlay on-screen when displays are added/removed or the
  /// resolution / dock / menu-bar geometry changes.
  private func observeScreenChanges() {
    NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in
        guard let self else { return }
        let presentation = overlayStateStore.presentation
        guard presentation != .hidden else { return }
        updateWindowFrame(for: presentation)
      }
      .store(in: &cancellables)
  }

  private func updateWindowFrame(for presentation: OverlayPresentation) {
    guard let window else { return }

    let size = panelSize(for: presentation)
    let frame = panelFrame(for: size)

    if window.frame.equalTo(frame) {
      return
    }

    window.setFrame(frame, display: true)
  }

  private func panelSize(for presentation: OverlayPresentation) -> CGSize {
    let standardWidth = 320 + closeButtonOverflow
    let recordingWidth = 232 + (closeButtonOverflow * 2)
    // Single-row card height: no separate footer bar row.
    let singleRowCardHeight = 108 + closeButtonOverflow
    // Prompt is a compact single-row notification.
    let promptHeight = 76 + closeButtonOverflow

    switch presentation {
    case .hidden:
      return CGSize(width: 1, height: 1)
    case .prompt:
      return CGSize(width: standardWidth, height: promptHeight)
    case .processed:
      return CGSize(width: standardWidth, height: singleRowCardHeight)
    case .recording:
      if layoutStore.current.orientation == .vertical {
        return CGSize(width: 80 + (closeButtonOverflow * 2), height: 236 + closeButtonOverflow)
      }
      return CGSize(width: recordingWidth, height: 60 + closeButtonOverflow)
    case .processing:
      return CGSize(width: standardWidth, height: singleRowCardHeight)
    case .error:
      return CGSize(width: standardWidth, height: singleRowCardHeight)
    }
  }

  private func panelFrame(for size: CGSize) -> NSRect {
    guard let screen = window?.screen ?? NSScreen.main else {
      return NSRect(x: 0, y: 0, width: size.width, height: size.height)
    }

    let prefs = layoutStore.current
    if prefs.hasCustomPosition {
      // Anchor by the stored top-left so all states share the same corner.
      let desired = NSPoint(x: prefs.left, y: prefs.top - size.height)
      let clamped = OverlayGeometry.clampOrigin(desired, size: size, visibleFrame: screen.visibleFrame)
      return NSRect(origin: clamped, size: size)
    }

    // Top-right by default so it doesn't sit on top of EkaScribe's top-centre widget.
    let x = screen.visibleFrame.maxX - size.width - Self.rightPadding
    let y = screen.frame.maxY - topPadding - size.height

    return NSRect(x: x, y: y, width: size.width, height: size.height)
  }
}
