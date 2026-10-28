import Foundation

private var checks = 0

private func expect(_ actual: GlobalShortcut?, _ expected: GlobalShortcut?, _ message: String) {
    guard actual == expected else {
        fputs("FAIL: \(message)\n  expected: \(String(describing: expected))\n  actual: \(String(describing: actual))\n", stderr)
        exit(1)
    }
    checks += 1
}

expect(
    parseGlobalShortcut("Command+Option+N"),
    GlobalShortcut(keyCode: 45, command: true, option: true, control: false, shift: false),
    "default shortcut"
)
expect(
    parseGlobalShortcut("⌃⌥n"),
    GlobalShortcut(keyCode: 45, command: false, option: true, control: true, shift: false),
    "symbol shortcut"
)
expect(parseGlobalShortcut(""), nil, "empty disables the shortcut")
expect(parseGlobalShortcut("Command+N"), nil, "a global shortcut needs two modifiers")
expect(parseGlobalShortcut("Command+Option+?"), nil, "unknown key")

print("shortcut: \(checks) checks passed")
