//
//  ProcessedOverlayView.swift
//  EkaCareDesktopHelper
//
//  Created by Lourdes Dinesh on 4/30/26.
//
import SwiftUI
import AppKit
import Combine

struct ProcessedOverlayView: View {
  let transactionId: String?
  let onView: () -> Void
  let onDismiss: () -> Void
  let onOpenApp: () -> Void
  
  @State private var isHovered = false
  @State private var progressState: Double = 1
  @State private var timerActive: Bool = false
  @State private var didAutoDismiss: Bool = false
  
  private let totalDuration: TimeInterval = 10
  private let timerInterval: TimeInterval = 0.05
  @State private var timer = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()
  
  var body: some View {
    OverlayContainer(onDismiss: onDismiss, closeButtonVisible: isHovered) {
      OverlayCard(width: 312, backgroundColor: .white) {
        VStack(spacing: 0) {
          HStack(alignment: .center, spacing: 10) {
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

            VStack(alignment: .leading, spacing: 0) {
              Text("Session completed")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(Color(red: 0.10, green: 0.10, blue: 0.10))
                .lineLimit(1)
              Text("Notes have been generated")
                .font(.system(size: 12, weight: .regular))
                .foregroundColor(Color(red: 0.46, green: 0.46, blue: 0.46))
                .lineLimit(1)
            }
            .layoutPriority(1)

            Spacer(minLength: 0)

            Button(action: onView) {
              HStack(spacing: 6) {
                Text("View")
                  .font(.system(size: 14, weight: .medium))
                Image(systemName: "chevron.right")
                  .font(.system(size: 11, weight: .semibold))
              }
              .foregroundColor(.white)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(Color(hex: "#215FFF"))
              .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
          }
          .padding(.vertical, 10)
          .padding(.horizontal, 14)

          ProgressView(value: progressState)
            .progressViewStyle(
              OverlayPromptProgressViewStyle(
                trackColor: Color(red: 0.94, green: 0.94, blue: 0.96),
                fillColor: Color(hex: "#215FFF")
              )
            )
            .frame(height: 3)
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier(transactionId ?? "no-transaction-id")
      }
    }
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.15)) {
        isHovered = hovering
      }
    }
    .onAppear {
      progressState = 1
      didAutoDismiss = false
      timerActive = true
    }
    .onDisappear {
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
  ProcessedOverlayView(transactionId: "asdf", onView: {}, onDismiss: {}, onOpenApp: {})
}
