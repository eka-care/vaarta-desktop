import SwiftUI
import AppKit

struct ProcessingOverlayView: View {
  let onDismiss: () -> Void
  let onOpenApp: () -> Void

  @State private var isHovered = false
  @State private var spinnerRotation: Double = 0

  var body: some View {
    OverlayContainer(onDismiss: onDismiss, closeButtonVisible: isHovered) {
      OverlayCard(backgroundColor: .white) {
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

          Circle()
            .trim(from: 0, to: 0.75)
            .stroke(Color(hex: "#215FFF"), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            .frame(width: 20, height: 20)
            .rotationEffect(.degrees(spinnerRotation))

          VStack(alignment: .leading, spacing: 2) {
            Text("Generating notes")
              .font(.system(size: 16, weight: .semibold))
              .foregroundColor(Color(hex: "#1A1A1A"))
              .lineLimit(1)

            Text("This may take 10-15 seconds")
              .font(.system(size: 12, weight: .regular))
              .foregroundColor(Color(hex: "#767676"))
              .lineLimit(1)
          }
          .layoutPriority(1)

          Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
      }
    }
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.15)) {
        isHovered = hovering
      }
    }
    .onAppear {
      startSpinner()
    }
    .transition(.move(edge: .top).combined(with: .opacity))
  }

  private func startSpinner() {
    withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) {
      spinnerRotation = 360
    }
  }
}

#Preview {
  ProcessingOverlayView(onDismiss: {}, onOpenApp: {})
}
