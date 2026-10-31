// dsh-operator macOS helper（P1-6 / P1-8 / P2 多屏标注）
//
// 两个模式：
//   ax-snapshot --pid <pid> [--max-nodes N] [--max-depth N]
//       读一份“最小取证”的 AX 树，输出 JSON（节点上限/深度由参数控制）。
//   ax-snapshot --list-windows [--pid <pid>]
//       输出显示器列表 + 可视窗口列表（CGWindowList）+ 前台 App。用于 list_windows 工具。
//
// 编译：scripts/build-ax-helper.sh（xcrun swiftc -O）

import AppKit
import ApplicationServices

struct Frame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Node: Codable {
    let index: Int
    let depth: Int
    let role: String
    let title: String
    let value: String?
    let frame: Frame
}

struct Output: Codable {
    let pid: Int32
    let appName: String
    let windowTitle: String?
    let windowFrame: Frame?
    let nodes: [Node]
    let truncated: Bool
}

struct DisplayInfo: Codable {
    let index: Int
    let primary: Bool
    let scale: Double
    let bounds: Frame
}

struct WindowInfo: Codable {
    let pid: Int32
    let app: String
    let title: String
    let windowID: Int
    let layer: Int
    let onScreen: Bool
    let bounds: Frame
}

struct WindowListOutput: Codable {
    let frontmostPid: Int32
    let frontmostApp: String
    let displays: [DisplayInfo]
    let windows: [WindowInfo]
    let truncated: Bool
}

struct PressOutput: Codable {
    let pressed: Bool
    let index: Int
    let role: String
    let title: String
    let error: String?
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return error == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let raw = attribute(element, name) else { return nil }
    if let text = raw as? String { return text }
    return nil
}

func frameAttribute(_ element: AXUIElement) -> Frame? {
    guard let positionRaw = attribute(element, kAXPositionAttribute),
          let sizeRaw = attribute(element, kAXSizeAttribute),
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(positionRaw as! AXValue, .cgPoint, &point)
    AXValueGetValue(sizeRaw as! AXValue, .cgSize, &size)
    guard size.width >= 1, size.height >= 1 else { return nil }
    return Frame(
        x: Double(point.x),
        y: Double(point.y),
        width: Double(size.width),
        height: Double(size.height)
    )
}

func children(of element: AXUIElement) -> [AXUIElement] {
    guard let raw = attribute(element, kAXChildrenAttribute) else { return [] }
    guard let list = raw as? [AXUIElement] else { return [] }
    return list
}

func valueAttribute(_ element: AXUIElement, role: String) -> String? {
    guard role != "AXSecureTextField" else { return "[secure]" }
    guard let raw = attribute(element, kAXValueAttribute) else { return nil }
    var text: String?
    if let string = raw as? String {
        text = string
    } else if let number = raw as? NSNumber {
        text = number.stringValue
    }
    guard let rawText = text, !rawText.isEmpty else { return nil }
    let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.count > 80 { return String(trimmed.prefix(80)) + "…" }
    return trimmed
}

// MARK: - 窗口 / 显示器

/// 系统自己的“窗口”：列出来只会干扰模型。
let systemWindowOwners: Set<String> = [
    "Window Server", "Dock", "Control Center", "Spotlight", "Notification Center",
    "SystemUIServer", "TextInputMenuAgent", "TextInputSwitcher", "com.apple.notificationcenterui"
]

/// Cocoa 坐标（左下原点）换成 CG 坐标（左上原点）。
func cgFrame(_ rect: NSRect, primaryHeight: CGFloat) -> Frame {
    Frame(
        x: Double(rect.origin.x),
        y: Double(primaryHeight - rect.origin.y - rect.height),
        width: Double(rect.width),
        height: Double(rect.height)
    )
}

func displayList() -> [DisplayInfo] {
    let screens = NSScreen.screens
    let primaryHeight = screens.first?.frame.height ?? 0
    return screens.enumerated().map { index, screen in
        DisplayInfo(
            index: index,
            primary: index == 0,
            scale: Double(screen.backingScaleFactor),
            bounds: cgFrame(screen.frame, primaryHeight: primaryHeight)
        )
    }
}

func windowList(pidFilter: Int32, limit: Int) -> WindowListOutput {
    let raw = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var windows: [WindowInfo] = []
    var truncated = false
    let ownPid = Int32(ProcessInfo.processInfo.processIdentifier)
    for entry in raw {
        if windows.count >= limit {
            truncated = true
            break
        }
        guard let pid = entry[kCGWindowOwnerPID as String] as? Int32 else { continue }
        if pid == 0 || pid == ownPid { continue }
        if pidFilter > 0 && pid != pidFilter { continue }
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        if layer > 25 { continue }
        let owner = entry[kCGWindowOwnerName as String] as? String ?? ""
        if systemWindowOwners.contains(owner) { continue }
        guard let boundsRaw = entry[kCGWindowBounds as String] as? [String: CGFloat],
              let rect = CGRect(dictionaryRepresentation: boundsRaw as CFDictionary) else { continue }
        if rect.width < 80 || rect.height < 40 { continue }
        let windowID = entry[kCGWindowNumber as String] as? Int ?? 0
        if windowID <= 0 { continue }
        let title = entry[kCGWindowName as String] as? String ?? ""
        windows.append(WindowInfo(
            pid: pid,
            app: owner,
            title: String(title.prefix(120)),
            windowID: windowID,
            layer: layer,
            onScreen: (entry[kCGWindowIsOnscreen as String] as? Bool) ?? true,
            bounds: Frame(
                x: Double(rect.minX),
                y: Double(rect.minY),
                width: Double(rect.width),
                height: Double(rect.height)
            )
        ))
    }
    windows.sort { left, right in
        if left.layer != right.layer { return left.layer < right.layer }
        if left.pid != right.pid { return left.pid < right.pid }
        return left.windowID < right.windowID
    }
    let frontmost = NSWorkspace.shared.frontmostApplication
    return WindowListOutput(
        frontmostPid: frontmost?.processIdentifier ?? 0,
        frontmostApp: frontmost?.localizedName ?? "",
        displays: displayList(),
        windows: windows,
        truncated: truncated
    )
}

func main() -> Int32 {
    let arguments = CommandLine.arguments
    var pid: Int32 = 0
    var pidFilter: Int32 = 0
    var maxNodes = 120
    var maxDepth = 12
    var listWindowsMode = false
    var pressIndex: Int? = nil
    var expectRole: String? = nil
    var expectTitle: String? = nil
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--pid":
            index += 1
            let value = Int32(arguments[index]) ?? 0
            pid = value
            pidFilter = value
        case "--max-nodes":
            index += 1
            maxNodes = max(1, Int(arguments[index]) ?? 120)
        case "--max-depth":
            index += 1
            maxDepth = max(1, Int(arguments[index]) ?? 12)
        case "--list-windows":
            listWindowsMode = true
        case "--press":
            index += 1
            pressIndex = Int(arguments[index])
        case "--expect-role":
            index += 1
            expectRole = arguments[index]
        case "--expect-title":
            index += 1
            expectTitle = arguments[index]
        default:
            break
        }
        index += 1
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]

    if listWindowsMode {
        let output = windowList(pidFilter: pidFilter, limit: 200)
        guard let data = try? encoder.encode(output) else {
            FileHandle.standardError.write(Data("ax-snapshot: failed to encode window list\n".utf8))
            return 4
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return 0
    }

    guard pid > 0 else {
        FileHandle.standardError.write(Data("ax-snapshot: --pid is required (or --list-windows)\n".utf8))
        return 2
    }
    if AXIsProcessTrusted() == false {
        FileHandle.standardError.write(Data("ax-snapshot: accessibility permission is not granted\n".utf8))
        return 3
    }

    let app = AXUIElementCreateApplication(pid)
    let appName = stringAttribute(app, kAXTitleAttribute) ?? ""
    let window: AXUIElement?
    if let raw = attribute(app, kAXFocusedWindowAttribute) {
        window = (raw as! AXUIElement)
    } else {
        window = nil
    }
    let windowTitle = window.flatMap { stringAttribute($0, kAXTitleAttribute) }
    let windowFrame = window.flatMap { frameAttribute($0) }

    // AXPress 后台投递：按快照里的节点 index 重新遍历（索引语义与快照一致），
    // 命中后先校验 role/title 期望，再对元素直接发 AXPress（不动光标、不抢焦点）。
    if let target = pressIndex {
        var validCount = 0
        var found: AXUIElement? = nil
        var foundRole = ""
        var foundTitle = ""
        var explored = 0
        var pressStack: [(element: AXUIElement, depth: Int)] = [(app, 0)]
        while pressStack.isEmpty == false && explored < 20000 {
            explored += 1
            let current = pressStack.removeLast()
            let element = current.element
            let role = stringAttribute(element, kAXRoleAttribute) ?? ""
            if !role.isEmpty, frameAttribute(element) != nil {
                if validCount == target {
                    found = element
                    foundRole = role
                    let rawTitle = stringAttribute(element, kAXTitleAttribute) ?? ""
                    let rawDescription = stringAttribute(element, kAXDescriptionAttribute) ?? ""
                    foundTitle = rawTitle.isEmpty ? rawDescription : rawTitle
                    break
                }
                validCount += 1
            }
            if current.depth < maxDepth {
                let childElements = children(of: element)
                for child in childElements.reversed() {
                    pressStack.append((child, current.depth + 1))
                }
            }
        }
        var pressed = false
        var error: String? = nil
        if found == nil {
            error = "element not found (index out of range)"
        } else if let role = expectRole, foundRole != role {
            error = "role mismatch: expected \(role), got \(foundRole)"
        } else if let needle = expectTitle, foundTitle.contains(needle) == false {
            error = "title mismatch: expected to contain \"\(needle)\""
        } else {
            let result = AXUIElementPerformAction(found!, kAXPressAction as CFString)
            if result == .success {
                pressed = true
            } else {
                error = "AXPress failed (AXError \(result.rawValue))"
            }
        }
        let output = PressOutput(
            pressed: pressed,
            index: target,
            role: foundRole,
            title: String(foundTitle.prefix(100)),
            error: error
        )
        guard let data = try? encoder.encode(output) else {
            FileHandle.standardError.write(Data("ax-snapshot: failed to encode press output\n".utf8))
            return 4
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return 0
    }

    var nodes: [Node] = []
    var truncated = false
    var stack: [(element: AXUIElement, depth: Int)] = [(app, 0)]
    while stack.isEmpty == false {
        if nodes.count >= maxNodes {
            truncated = true
            break
        }
        let current = stack.removeLast()
        let element = current.element
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        guard !role.isEmpty else { continue }
        if let frame = frameAttribute(element) {
            let rawTitle = stringAttribute(element, kAXTitleAttribute) ?? ""
            let rawDescription = stringAttribute(element, kAXDescriptionAttribute) ?? ""
            let title = rawTitle.isEmpty ? rawDescription : rawTitle
            nodes.append(Node(
                index: nodes.count,
                depth: current.depth,
                role: role,
                title: String(title.prefix(100)),
                value: valueAttribute(element, role: role),
                frame: frame
            ))
        }
        if current.depth < maxDepth {
            let childElements = children(of: element)
            for child in childElements.reversed() {
                stack.append((child, current.depth + 1))
            }
        }
    }

    let output = Output(
        pid: pid,
        appName: appName,
        windowTitle: windowTitle,
        windowFrame: windowFrame,
        nodes: nodes,
        truncated: truncated
    )
    guard let data = try? encoder.encode(output) else {
        FileHandle.standardError.write(Data("ax-snapshot: failed to encode output\n".utf8))
        return 4
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
}

exit(main())
