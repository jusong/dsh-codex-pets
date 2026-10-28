import CoreGraphics

/// Where the question card sits: 12px off the pet's visible edge, flipping
/// to the other side when that would leave the screen.
func askDialogOrigin(pet: CGRect, dialog: CGSize, visible: CGRect, gap: CGFloat = 12) -> CGPoint {
    var origin = CGPoint(x: pet.maxX + gap, y: pet.midY - dialog.height / 2)
    if origin.x + dialog.width > visible.maxX {
        origin.x = pet.minX - dialog.width - gap
    }
    origin.x = min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - dialog.width))
    origin.y = min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - dialog.height))
    return origin
}
