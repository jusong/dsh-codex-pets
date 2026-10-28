import Foundation

struct GlobalShortcut: Equatable {
    let keyCode: UInt32
    let command: Bool
    let option: Bool
    let control: Bool
    let shift: Bool
}

private let shortcutKeys: [String: UInt32] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
    "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
    "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32,
    "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
]

/// The host sends `shortcut` plus one JSON string. A top-level string is a
/// fragment, so the default JSON parser rejects it and the old hotkey stays.
func shortcutFromWire(_ raw: String) -> String? {
    guard let data = raw.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
          let text = value as? String else { return nil }
    return text
}

func parseGlobalShortcut(_ value: String) -> GlobalShortcut? {
    let expanded = value
        .replacingOccurrences(of: "⌘", with: "+Command+")
        .replacingOccurrences(of: "⌥", with: "+Option+")
        .replacingOccurrences(of: "⌃", with: "+Control+")
        .replacingOccurrences(of: "⇧", with: "+Shift+")
    let tokens = expanded
        .split(separator: "+")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
        .filter { !$0.isEmpty }
    guard !tokens.isEmpty else { return nil }

    var command = false
    var option = false
    var control = false
    var shift = false
    var keyCode: UInt32?
    for token in tokens {
        switch token {
        case "COMMAND", "CMD": command = true
        case "OPTION", "OPT", "ALT": option = true
        case "CONTROL", "CTRL": control = true
        case "SHIFT": shift = true
        default:
            guard keyCode == nil, let code = shortcutKeys[token] else { return nil }
            keyCode = code
        }
    }
    let modifierCount = [command, option, control, shift].filter { $0 }.count
    guard modifierCount >= 2, let keyCode else { return nil }
    return GlobalShortcut(
        keyCode: keyCode,
        command: command,
        option: option,
        control: control,
        shift: shift
    )
}
