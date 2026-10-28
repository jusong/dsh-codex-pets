import CoreGraphics
import Foundation

let dialog = CGSize(width: 360, height: 72)
let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
let pet = CGRect(x: 200, y: 500, width: 120, height: 120)
let beside = askDialogOrigin(pet: pet, dialog: dialog, visible: screen)
precondition(beside.x == 332, "the card sits 12px past the pet, not the whole window")
precondition(beside.y == 524, "the card is centered on the pet")

let crowded = CGRect(x: 1200, y: 500, width: 120, height: 120)
let flipped = askDialogOrigin(pet: crowded, dialog: dialog, visible: screen)
precondition(flipped.x == 828, "a card that would leave the screen flips to the pet's other side")
print("ask-layout ok")
