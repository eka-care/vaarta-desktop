import SwiftUI

/// A slim hover-revealed footer bar added to every overlay card state
/// (prompt / processing / processed / error).
/// Contains: drag handle, tappable logo, and orientation toggle.
struct OverlayCardFooterBar: View {
  let onOpenApp: () -> Void

  @EnvironmentObject private var layoutStore: OverlayLayoutPreferencesStore
  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 8) {
      // Drag handle
      DragHandle(onDragEnded: { left, top in
        layoutStore.updatePosition(left: left, top: top)
      })
      .frame(width: 18, height: 18)
      .opacity(isHovered ? 1 : 0)

      Spacer()

      // Logo — tap to open the main app
      Button(action: onOpenApp) {
        Image("ekaLogoBlue")
          .resizable()
          .renderingMode(.original)
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(width: 16, height: 16)
      }
      .buttonStyle(.plain)
      .focusable(false)
      .help("Open Vaarta")

      Spacer()

      // Orientation toggle
      Button(action: { layoutStore.toggleOrientation() }) {
        let isVertical = layoutStore.current.orientation == .vertical
        Image(systemName: isVertical ? "rectangle.split.3x1" : "rectangle.split.1x2")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(Color(white: 0.5))
          .frame(width: 16, height: 16)
      }
      .buttonStyle(.plain)
      .focusable(false)
      .opacity(isHovered ? 1 : 0)
      .help(layoutStore.current.orientation == .vertical ? "Switch to horizontal" : "Switch to vertical")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 6)
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.15)) { isHovered = hovering }
    }
  }
}
