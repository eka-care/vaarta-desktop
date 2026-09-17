//
//  RecordingOverlayView.swift
//  EkaCareDesktopHelper
//
//  Created by Lourdes Dinesh on 4/30/26.
//

import SwiftUI
import AppKit
import Combine
import ImageIO

struct RecordingOverlayView: View {
  let isPaused: Bool
  let onPauseToggle: () -> Void
  let onStop: () -> Void
  let onDismiss: () -> Void
  let onOpenApp: () -> Void

  @EnvironmentObject private var layoutStore: OverlayLayoutPreferencesStore
  @State private var isHovered = false

  private var isVertical: Bool { layoutStore.current.orientation == .vertical }

  var body: some View {
    OverlayContainer(onDismiss: onDismiss, closeButtonVisible: isHovered) {
      OverlayCard(width: nil, backgroundColor: .white) {
        Group {
          if isVertical {
            VStack(spacing: 8) { controls }
          } else {
            HStack(spacing: 8) { controls }
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(Color.white)
      }
      .fixedSize()
      .clipShape(isVertical ? AnyShape(RoundedRectangle(cornerRadius: 22, style: .continuous)) : AnyShape(Capsule()))
      .overlay(
        Group {
          if isVertical {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
              .stroke(Color.white.opacity(0.07), lineWidth: 1)
          } else {
            Capsule().stroke(Color.white.opacity(0.07), lineWidth: 1)
          }
        }
      )
      // Visibility shadow is provided at the window level (panel.hasShadow).
    }
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.15)) {
        isHovered = hovering
      }
    }
    .transition(.scale(scale: 0.96).combined(with: .opacity))
  }

  @ViewBuilder
  private var controls: some View {
    // Drag handle (3x3 dots) — reserves space, fades in on hover.
    DragHandle(onDragEnded: { left, top in
      layoutStore.updatePosition(left: left, top: top)
    })
    .frame(width: 18, height: 24)
    .opacity(isHovered ? 1 : 0)

    // Logo — opens / focuses the main app on click.
    Button(action: onOpenApp) {
      Image("ekaLogoBlue")
        .resizable()
        .renderingMode(.original)
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(width: 22, height: 22)
    }
    .buttonStyle(.plain)
    .focusable(false)
    .help("Open Vaarta")

    RecordingWaveformGifView(width: 36, height: 36, isAnimating: !isPaused)
      .frame(width: 36, height: 36)
      .clipped()

    Button(action: onPauseToggle) {
      if isPaused {
        PlayGlyph()
      } else {
        PauseGlyph()
      }
    }
    .buttonStyle(IconRingButtonStyle(strokeColor: Color(red: 33/255, green: 95/255, blue: 1.0)))
    .focusable(false)

    Button(action: onStop) {
      StopGlyph()
    }
    .buttonStyle(IconRingButtonStyle(strokeColor: Color(red: 229/255, green: 57/255, blue: 53/255)))
    .focusable(false)

    // Orientation toggle — reserves space, fades in on hover.
    Button(action: { layoutStore.toggleOrientation() }) {
      Image(systemName: isVertical ? "rectangle.split.3x1" : "rectangle.split.1x2")
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(Color(white: 0.45))
        .frame(width: 16, height: 16)
    }
    .buttonStyle(.plain)
    .focusable(false)
    .opacity(isHovered ? 1 : 0)
    .help(isVertical ? "Switch to horizontal" : "Switch to vertical")
  }
}

/// A 3x3 dot grid that drags the overlay window while the mouse is held. The
/// dots are drawn in SwiftUI; an AppKit view underneath captures the drag so the
/// borderless panel can be repositioned precisely.
struct DragHandle: View {
  let onDragEnded: (_ left: CGFloat, _ top: CGFloat) -> Void

  var body: some View {
    DragHandleCaptureView(onDragEnded: onDragEnded)
      .overlay(
        DotGrid()
          .allowsHitTesting(false)
      )
  }
}

private struct DotGrid: View {
  private let dot = Color(white: 0.62)

  var body: some View {
    VStack(spacing: 3) {
      ForEach(0..<3, id: \.self) { _ in
        HStack(spacing: 3) {
          ForEach(0..<3, id: \.self) { _ in
            Circle().fill(dot).frame(width: 2.5, height: 2.5)
          }
        }
      }
    }
  }
}

struct DragHandleCaptureView: NSViewRepresentable {
  let onDragEnded: (_ left: CGFloat, _ top: CGFloat) -> Void

  func makeNSView(context: Context) -> DragHandleNSView {
    let view = DragHandleNSView()
    view.onDragEnded = onDragEnded
    return view
  }

  func updateNSView(_ nsView: DragHandleNSView, context: Context) {
    nsView.onDragEnded = onDragEnded
  }
}

final class DragHandleNSView: NSView {
  var onDragEnded: ((CGFloat, CGFloat) -> Void)?

  private var windowStartOrigin: NSPoint = .zero
  private var mouseStartGlobal: NSPoint = .zero

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    windowStartOrigin = window.frame.origin
    mouseStartGlobal = NSEvent.mouseLocation
    NSCursor.closedHand.set()
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window else { return }
    let current = NSEvent.mouseLocation
    let desired = NSPoint(
      x: windowStartOrigin.x + (current.x - mouseStartGlobal.x),
      y: windowStartOrigin.y + (current.y - mouseStartGlobal.y)
    )
    let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? window.frame
    let clamped = OverlayGeometry.clampOrigin(desired, size: window.frame.size, visibleFrame: visible)
    window.setFrameOrigin(clamped)
  }

  override func mouseUp(with event: NSEvent) {
    NSCursor.openHand.set()
    guard let window else { return }
    // Persist the top-left anchor (left edge + top edge in AppKit coords).
    onDragEnded?(window.frame.minX, window.frame.maxY)
  }
}

struct PauseGlyph: View {
  var body: some View {
    HStack(spacing: 2) {
      RoundedRectangle(cornerRadius: 0.5, style: .continuous)
        .fill(Color(red: 33/255, green: 95/255, blue: 1.0))
        .frame(width: 3, height: 10)
      RoundedRectangle(cornerRadius: 0.5, style: .continuous)
        .fill(Color(red: 33/255, green: 95/255, blue: 1.0))
        .frame(width: 3, height: 10)
    }
    .frame(width: 16, height: 16)
  }
}

struct PlayGlyph: View {
  var body: some View {
    Image(systemName: "play.fill")
      .font(.system(size: 10, weight: .bold))
      .foregroundColor(Color(red: 33/255, green: 95/255, blue: 1.0))
      .frame(width: 16, height: 16)
      .offset(x: 0.5)
  }
}

struct StopGlyph: View {
  var body: some View {
    RoundedRectangle(cornerRadius: 1, style: .continuous)
      .fill(Color(red: 229/255, green: 57/255, blue: 53/255))
      .frame(width: 10, height: 10)
      .frame(width: 16, height: 16)
  }
}


struct RecordingWaveformGifView: NSViewRepresentable {
  let width: CGFloat
  let height: CGFloat
  let isAnimating: Bool
  
  func makeNSView(context: Context) -> RecordingWaveformAnimatedView {
    RecordingWaveformAnimatedView(width: width, height: height, isAnimating: isAnimating)
  }
  
  func updateNSView(_ nsView: RecordingWaveformAnimatedView, context: Context) {
    nsView.updateSize(width: width, height: height)
    nsView.updateAnimationState(isAnimating: isAnimating)
  }
}

final class RecordingWaveformAnimatedView: NSView {
  private struct Frame {
    let image: CGImage
    let duration: TimeInterval
  }
  
  private let imageLayer = CALayer()
  private var waveformSize: NSSize
  private var frames: [Frame] = []
  private var currentFrameIndex = 0
  private var animationTimer: Timer?
  private var isAnimating = true
  
  override var intrinsicContentSize: NSSize {
    waveformSize
  }
  
  init(width: CGFloat, height: CGFloat, isAnimating: Bool) {
    waveformSize = NSSize(width: width, height: height)
    self.isAnimating = isAnimating
    super.init(frame: NSRect(origin: .zero, size: waveformSize))
    wantsLayer = true
    layer?.masksToBounds = true
    
    imageLayer.contentsGravity = .resizeAspect
    imageLayer.masksToBounds = true
    layer?.addSublayer(imageLayer)
    
    loadFrames()
    if isAnimating {
      startAnimatingIfNeeded()
    }
  }
  
  override func layout() {
    super.layout()
    imageLayer.frame = bounds
  }
  
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    
    if window == nil {
      animationTimer?.invalidate()
      animationTimer = nil
    } else if isAnimating {
      startAnimatingIfNeeded()
    }
  }
  
  func updateSize(width: CGFloat, height: CGFloat) {
    let newSize = NSSize(width: width, height: height)
    guard waveformSize != newSize else { return }
    
    waveformSize = newSize
    frame.size = newSize
    invalidateIntrinsicContentSize()
    needsLayout = true
  }
  
  func updateAnimationState(isAnimating: Bool) {
    guard self.isAnimating != isAnimating else { return }
    
    self.isAnimating = isAnimating
    if isAnimating {
      startAnimatingIfNeeded()
    } else {
      animationTimer?.invalidate()
      animationTimer = nil
    }
  }
  
  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
  
  deinit {
    animationTimer?.invalidate()
  }
  
  private func loadFrames() {
    guard let gifURL = Bundle.main.url(forResource: "voice-recording", withExtension: "gif"),
          let imageSource = CGImageSourceCreateWithURL(gifURL as CFURL, nil) else {
      return
    }
    
    let frameCount = CGImageSourceGetCount(imageSource)
    frames = (0..<frameCount).compactMap { index in
      guard let cgImage = CGImageSourceCreateImageAtIndex(imageSource, index, nil) else {
        return nil
      }
      
      return Frame(image: cgImage, duration: frameDuration(for: imageSource, at: index))
    }
    
    imageLayer.contents = frames.first?.image
  }
  
  private func startAnimatingIfNeeded() {
    guard isAnimating, animationTimer == nil, frames.count > 1 else { return }
    scheduleNextFrame()
  }
  
  private func scheduleNextFrame() {
    guard !frames.isEmpty else { return }
    
    let frame = frames[currentFrameIndex]
    imageLayer.contents = frame.image
    
    animationTimer?.invalidate()
    animationTimer = Timer.scheduledTimer(withTimeInterval: frame.duration, repeats: false) { [weak self] _ in
      guard let self else { return }
      currentFrameIndex = (currentFrameIndex + 1) % frames.count
      scheduleNextFrame()
    }
  }
  
  private func frameDuration(for imageSource: CGImageSource, at index: Int) -> TimeInterval {
    guard
      let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, index, nil) as? [CFString: Any],
      let gifProperties = properties[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    else {
      return 0.1
    }
    
    let unclampedDelay = gifProperties[kCGImagePropertyGIFUnclampedDelayTime] as? TimeInterval
    let delay = gifProperties[kCGImagePropertyGIFDelayTime] as? TimeInterval
    let duration = unclampedDelay ?? delay ?? 0.1
    return duration > 0.02 ? duration : 0.1
  }
}

#Preview {
  RecordingOverlayView(
    isPaused: true,
    onPauseToggle: { },
    onStop: { },
    onDismiss: { },
    onOpenApp: { }
  )
  .environmentObject(OverlayLayoutPreferencesStore())
}
