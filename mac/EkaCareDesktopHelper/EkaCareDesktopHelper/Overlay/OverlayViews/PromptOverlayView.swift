import SwiftUI
import AppKit
import Combine

struct PromptOverlayView: View {
  let appName: String?
  let onStart: () -> Void
  let onDismiss: () -> Void
  let onOpenApp: () -> Void

  @State private var isHovered = false
  @State private var isStarting = false
  @State private var progressState: Double = 1
  @State private var timerActive: Bool = false
  @State private var didAutoDismiss: Bool = false
  @State private var startTimeoutWorkItem: DispatchWorkItem?

  private let totalDuration: TimeInterval = 25
  private let startTimeoutDuration: TimeInterval = 10
  private let timerInterval: TimeInterval = 0.05

  @State private var timer = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()

  private func handleStart() {
    guard !isStarting else { return }
    isStarting = true
    timerActive = false
    startTimeoutWorkItem?.cancel()
    let timeoutWorkItem = DispatchWorkItem {
      guard isStarting else { return }
      isStarting = false
      onDismiss()
    }
    startTimeoutWorkItem = timeoutWorkItem
    DispatchQueue.main.asyncAfter(deadline: .now() + startTimeoutDuration, execute: timeoutWorkItem)
    onStart()
  }

  var body: some View {
    OverlayContainer(onDismiss: onDismiss, closeButtonVisible: isHovered) {
      OverlayCard(backgroundColor: Color.white) {
        VStack(spacing: 0) {
          // Single-row content: logo | title + appName | start btn | dropdown
          HStack(alignment: .center, spacing: 10) {
            // Blue Eka logo — tapping opens the main app
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

            // Title + optional app name
            VStack(alignment: .leading, spacing: 2) {
              Text("Meeting detected")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Color(hex: "#1A1A1A"))
                .lineLimit(1)
              if let name = appName {
                Text(name)
                  .font(.system(size: 12, weight: .regular))
                  .foregroundColor(Color(hex: "#757575"))
                  .lineLimit(1)
              }
            }
            .layoutPriority(1)

            Spacer(minLength: 0)

            // Start button
            Button(action: handleStart) {
              HStack(spacing: 4) {
                if isStarting {
                  ProgressView()
                    .controlSize(.small)
                    .tint(.white)
                } else {
                  Image(.ekaLogoWhite)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 13, height: 13)
                }
                Text(isStarting ? "Starting…" : "Start")
                  .lineLimit(1)
              }
              .padding(.horizontal, 10)
              .frame(height: 30)
            }
            .buttonStyle(PromptStartSplitButtonStyle())
            .disabled(isStarting)
            .fixedSize()

            // ▼ dropdown for per-app disable
            Menu {
              if let name = appName {
                Button("Don't show for \(name)") {
                  DisabledAppsPreferencesStore.shared.disable(name)
                  onDismiss()
                }
                Divider()
              }
              Button("Reset all disabled apps") {
                DisabledAppsPreferencesStore.shared.resetAll()
              }
            } label: {
              ZStack {
                RoundedRectangle(cornerRadius: 8)
                  .fill(Color(hex: "#F3F4F6"))
                  .frame(width: 28, height: 28)
                Image(systemName: "chevron.down")
                  .font(.system(size: 9, weight: .semibold))
                  .foregroundColor(Color(hex: "#6B7280"))
              }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 12)

          // Countdown progress bar
          ProgressView(value: progressState)
            .progressViewStyle(
              OverlayPromptProgressViewStyle(
                trackColor: Color.black.opacity(0.08),
                fillColor: Color(hex: "#215FFF")
              )
            )
            .frame(height: 4)
        }
      }
    }
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.15)) {
        isHovered = hovering
      }
    }
    .onAppear {
      isStarting = false
      progressState = 1
      didAutoDismiss = false
      timerActive = true
    }
    .onDisappear {
      startTimeoutWorkItem?.cancel()
      startTimeoutWorkItem = nil
      isStarting = false
      timerActive = false
      didAutoDismiss = false
      progressState = 1
    }
    .onReceive(timer) { _ in
      guard timerActive, !didAutoDismiss else { return }
      let decrementAmount = timerInterval / totalDuration
      progressState -= decrementAmount
      if progressState <= 0 {
        progressState = 0
        didAutoDismiss = true
        onDismiss()
      }
    }
    .transition(.move(edge: .top).combined(with: .opacity))
  }
}

#Preview {
  PromptOverlayView(
    appName: "Google Chrome",
    onStart: {},
    onDismiss: {},
    onOpenApp: {}
  )
  .environmentObject(OverlayLayoutPreferencesStore())
}
