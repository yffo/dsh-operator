// dsh-operator macOS helper（P1-6 / P1-8 / P2 多屏标注）
//
// 两个模式：
//   ax-snapshot --pid <pid> [--max-nodes N] [--max-depth N]
//       读一份“最小取证”的 AX 树，输出 JSON（节点上限/深度由参数控制）。
//   ax-snapshot --list-windows [--pid <pid>]
//       输出显示器列表 + 可视窗口列表（CGWindowList）+ 前台 App。用于 list_windows 工具。
//   ax-snapshot --pid <pid> --press <index> [--expect-role R] [--expect-title T]
//       按快照索引语义后台 AXPress（不移动光标）。
//   ax-snapshot --pid <pid> --set-value <index> --value <文本> [--expect-role R]
//       直接写原生文本框的值（AXTextField/AXTextArea/AXComboBox/AXSearchField），不经过剪贴板。
//   ax-snapshot --pid <pid> --menu <路径，用 / 分隔> [--menu-item 段]...
//   ax-snapshot --pid <pid> --scroll <index> --direction up|down|left|right [--page] [--expect-role R] [--expect-title T]
//       后台点菜单路径（如 "文件/新建"）。
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

// MARK: - 共用：按索引找节点

struct FoundNode {
    let element: AXUIElement
    let role: String
    let title: String
    let index: Int
}

func findNodeIndexed(app: AXUIElement, target: Int, maxDepth: Int) -> FoundNode? {
    var validCount = 0
    var explored = 0
    var stack: [(element: AXUIElement, depth: Int)] = [(app, 0)]
    while stack.isEmpty == false && explored < 20000 {
        explored += 1
        let current = stack.removeLast()
        let element = current.element
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        if !role.isEmpty, frameAttribute(element) != nil {
            if validCount == target {
                let rawTitle = stringAttribute(element, kAXTitleAttribute) ?? ""
                let rawDescription = stringAttribute(element, kAXDescriptionAttribute) ?? ""
                return FoundNode(
                    element: element,
                    role: role,
                    title: rawTitle.isEmpty ? rawDescription : rawTitle,
                    index: target
                )
            }
            validCount += 1
        }
        if current.depth < maxDepth {
            for child in children(of: element).reversed() {
                stack.append((child, current.depth + 1))
            }
        }
    }
    return nil
}

/// 索引漂移兜底：按 role + title 在新鲜树里重定位（要求唯一命中）。
func findNodeByIdentity(app: AXUIElement, role: String?, title: String?, maxDepth: Int, target: Int, maxDistance: Int = 16) -> FoundNode? {
    // 索引漂移是常态（观察与动作之间树会变）。按 role/title 在新鲜树里重新定位：
    // 取“节点索引与旧 index 最近”的唯一候选，距离超过 maxDistance 视为不可信，宁可失败。
    var best: (node: FoundNode, distance: Int)? = nil
    var validCount = 0
    var explored = 0
    var stack: [(element: AXUIElement, depth: Int)] = [(app, 0)]
    while stack.isEmpty == false && explored < 20000 {
        explored += 1
        let current = stack.removeLast()
        let element = current.element
        let nodeRole = stringAttribute(element, kAXRoleAttribute) ?? ""
        var nodeIndex = -1
        if !nodeRole.isEmpty, frameAttribute(element) != nil {
            nodeIndex = validCount
            validCount += 1
        }
        if nodeIndex >= 0 {
            let rawTitle = stringAttribute(element, kAXTitleAttribute) ?? ""
            let rawDescription = stringAttribute(element, kAXDescriptionAttribute) ?? ""
            let nodeTitle = rawTitle.isEmpty ? rawDescription : rawTitle
            let roleOk = role == nil || nodeRole == role!
            let titleOk = title == nil || nodeTitle.contains(title!)
            if roleOk && titleOk && !(role == nil && title == nil) {
                let distance = abs(nodeIndex - target)
                if best == nil || distance < best!.distance {
                    best = (FoundNode(element: element, role: nodeRole, title: nodeTitle, index: nodeIndex), distance: distance)
                }
            }
        }
        if current.depth < maxDepth {
            for child in children(of: element).reversed() {
                stack.append((child, current.depth + 1))
            }
        }
    }
    guard let candidate = best, candidate.distance <= maxDistance else { return nil }
    return candidate.node
}

func findLargestScrollable(app: AXUIElement, role: String, title: String?, maxDepth: Int) -> FoundNode? {
    // 没有快照索引时按 role/title 自动选滚动容器：取 frame 面积最大的匹配节点。
    var best: (node: FoundNode, area: Double)? = nil
    var validCount = 0
    var explored = 0
    var stack: [(element: AXUIElement, depth: Int)] = [(app, 0)]
    while stack.isEmpty == false && explored < 20000 {
        explored += 1
        let current = stack.removeLast()
        let element = current.element
        let nodeRole = stringAttribute(element, kAXRoleAttribute) ?? ""
        var nodeIndex = -1
        var frameArea: Double = 0
        if !nodeRole.isEmpty, let f = frameAttribute(element) {
            nodeIndex = validCount
            validCount += 1
            frameArea = f.width * f.height
        }
        if nodeIndex >= 0, nodeRole == role {
            let rawTitle = stringAttribute(element, kAXTitleAttribute) ?? ""
            let rawDescription = stringAttribute(element, kAXDescriptionAttribute) ?? ""
            let nodeTitle = rawTitle.isEmpty ? rawDescription : rawTitle
            if title == nil || nodeTitle.contains(title!) {
                let area = frameArea
                if best == nil || area > best!.area {
                    best = (FoundNode(element: element, role: nodeRole, title: nodeTitle, index: nodeIndex), area)
                }
            }
        }
        if current.depth < maxDepth {
            for child in children(of: element).reversed() {
                stack.append((child, current.depth + 1))
            }
        }
    }
    return best?.node
}

// MARK: - 输出结构（新增模式）

struct SetValueOutput: Codable {
    let ok: Bool
    let index: Int
    let role: String
    let title: String
    let resolved: String?
    let error: String?
}

struct ScrollOutput: Codable {
    let ok: Bool
    let index: Int
    let role: String
    let direction: String
    let page: Bool
    let resolved: String?
    let error: String?
}

let resolvedNote = "index drifted; re-resolved by role/title"


struct MenuOutput: Codable {
    let ok: Bool
    let path: [String]
    let error: String?
}

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

// MARK: - 菜单：沿路径 AXPress（后台）

func menuChild(of parent: AXUIElement, title: String) -> AXUIElement? {
    func search(_ element: AXUIElement) -> AXUIElement? {
        let kids = children(of: element)
        for kid in kids {
            let kidTitle = stringAttribute(kid, kAXTitleAttribute) ?? ""
            if kidTitle == title { return kid }
        }
        for kid in kids where (stringAttribute(kid, kAXRoleAttribute) ?? "") == "AXMenu" {
            if let hit = search(kid) { return hit }
        }
        return nil
    }
    return search(parent)
}

func pressMenuPath(app: AXUIElement, path: [String]) -> MenuOutput {
    guard path.isEmpty == false else {
        return MenuOutput(ok: false, path: path, error: "empty menu path")
    }
    guard let rawBar = attribute(app, kAXMenuBarAttribute) else {
        return MenuOutput(ok: false, path: path, error: "menu bar not available")
    }
    var current = rawBar as! AXUIElement
    for (offset, segment) in path.enumerated() {
        guard let item = menuChild(of: current, title: segment) else {
            return MenuOutput(ok: false, path: path, error: "menu item not found: \(segment)")
        }
        if offset == path.count - 1 {
            let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
            return result == .success
                ? MenuOutput(ok: true, path: path, error: nil)
                : MenuOutput(ok: false, path: path, error: "AXPress failed (AXError \(result.rawValue))")
        }
        _ = AXUIElementPerformAction(item, kAXPressAction as CFString)
        usleep(40_000)
        current = item
    }
    return MenuOutput(ok: true, path: path, error: nil)
}

// MARK: - 滚动回退：CGEvent scroll wheel 投递到目标进程

func cgScrollFallback(element: AXUIElement, app: AXUIElement, pid: Int32, direction: String, page: Bool, target: Int, role: String) -> ScrollOutput? {
    guard let frame = frameAttribute(element) else { return nil }
    let horizontal = direction == "left" || direction == "right"
    let step: Int32 = page ? 10 : 3
    let positive = direction == "up" || direction == "left"
    let delta = positive ? step : -step
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 1,
        wheel1: horizontal ? 0 : delta,
        wheel2: horizontal ? delta : 0,
        wheel3: 0
    ) else { return nil }
    let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
    event.location = center
    // 滚轮事件多数 App 只认前台：需要先把目标 App/窗口提到前台（工具描述需写明）。
    if let windowValue = attribute(app, kAXFocusedWindowAttribute) {
        let window = windowValue as! AXUIElement
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    if let running = NSRunningApplication(processIdentifier: pid) {
        running.activate(options: [.activateIgnoringOtherApps])
    }
    usleep(200_000)
    event.post(tap: .cghidEventTap)
    usleep(60_000)
    return ScrollOutput(ok: true, index: target, role: role, direction: direction, page: page, resolved: nil, error: nil)
}

// MARK: - 主入口

func main() -> Int32 {
    let arguments = CommandLine.arguments
    var pid: Int32 = 0
    var pidFilter: Int32 = 0
    var maxNodes = 120
    var maxDepth = 12
    var listWindowsMode = false
    var pressIndex: Int? = nil
    var scrollIndex: Int? = nil
    var scrollDirection = "down"
    var scrollPage = false
    var setValueIndex: Int? = nil
    var setValueText: String? = nil
    var menuPath: [String]? = nil
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
        case "--scroll":
            index += 1
            scrollIndex = Int(arguments[index])
        case "--direction":
            index += 1
            scrollDirection = arguments[index].lowercased()
        case "--page":
            scrollPage = true
        case "--set-value":
            index += 1
            setValueIndex = Int(arguments[index])
        case "--value":
            index += 1
            setValueText = arguments[index]
        case "--menu":
            index += 1
            menuPath = arguments[index].split(separator: "/").map(String.init)
        case "--menu-item":
            index += 1
            var path = menuPath ?? []
            path.append(arguments[index])
            menuPath = path
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

    // 后台写原生文本框的值（不经过剪贴板/键盘）
    if let target = setValueIndex {
        guard let text = setValueText else {
            FileHandle.standardError.write(Data("ax-snapshot: --value is required with --set-value\n".utf8))
            return 2
        }
        var found = findNodeIndexed(app: app, target: target, maxDepth: maxDepth)
        var resolved = false
        if found == nil || (expectRole != nil && found!.role != expectRole!) || (expectTitle != nil && found!.title.contains(expectTitle!) == false) {
            if expectRole != nil || expectTitle != nil, let redo = findNodeByIdentity(app: app, role: expectRole, title: expectTitle, maxDepth: maxDepth, target: target) {
                found = redo
                resolved = true
            }
        }
        guard let foundNode = found else {
            return emit(encoder, SetValueOutput(ok: false, index: target, role: "", title: "", resolved: nil, error: "element not found (index out of range)"))
        }
        if let role = expectRole, foundNode.role != role {
            return emit(encoder, SetValueOutput(ok: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), resolved: nil, error: "role mismatch: expected \(role), got \(foundNode.role)"))
        }
        if textRoles.contains(foundNode.role) == false {
            return emit(encoder, SetValueOutput(ok: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), resolved: nil, error: "role \(foundNode.role) is not a text field"))
        }
        let result = AXUIElementSetAttributeValue(foundNode.element, kAXValueAttribute as CFString, text as CFString)
        let output: SetValueOutput
        if result == .success {
            output = SetValueOutput(ok: true, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), resolved: resolved ? resolvedNote : nil, error: nil)
        } else {
            output = SetValueOutput(ok: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), resolved: nil, error: "AXSetValue failed (AXError \(result.rawValue))")
        }
        return emit(encoder, output)
    }


    // AX 原生滚动：对 AXScrollArea（或支持滚动动作的元素）发 page/line 滚动动作。
    // 有 index 时按索引（含 role/title 漂移重定位）；没有 index 但给了 expect-role/title 时
    // 自动选同角色里 frame 面积最大的容器，模型不必先做原始扫描。
    var scrollFound: FoundNode? = nil
    if let target = scrollIndex {
        var found = findNodeIndexed(app: app, target: target, maxDepth: maxDepth)
        if found == nil || (expectRole != nil && found!.role != expectRole!) {
            if expectRole != nil || expectTitle != nil, let redo = findNodeByIdentity(app: app, role: expectRole, title: expectTitle, maxDepth: maxDepth, target: target) {
                found = redo
            }
        }
        scrollFound = found
    } else if expectRole != nil || expectTitle != nil {
        scrollFound = findLargestScrollable(app: app, role: expectRole ?? "AXScrollArea", title: expectTitle, maxDepth: maxDepth)
    }
    if let foundNode = scrollFound {
        let target = foundNode.index
        let actions: [String: (page: String, line: String)] = [
            "down": ("AXScrollDownByPage", "AXScrollDown"),
            "up": ("AXScrollUpByPage", "AXScrollUp"),
            "left": ("AXScrollLeftByPage", "AXScrollLeft"),
            "right": ("AXScrollRightByPage", "AXScrollRight")
        ]
        guard let pair = actions[scrollDirection] else {
            return emit(encoder, ScrollOutput(ok: false, index: target, role: foundNode.role, direction: scrollDirection, page: scrollPage, resolved: nil, error: "direction must be up/down/left/right"))
        }
        let actionName = scrollPage ? pair.page : pair.line
        let result = AXUIElementPerformAction(foundNode.element, actionName as CFString)
        if result == .success {
            return emit(encoder, ScrollOutput(ok: true, index: target, role: foundNode.role, direction: scrollDirection, page: scrollPage, resolved: nil, error: nil))
        }
        // AXScrollArea 在部分 App（如 Finder 图标视图）不支持 AX 滚动动作，
        // 回退为把 scroll wheel 事件直接投递到目标进程（仍不移动光标/不抢焦点）。
        if let fallback = cgScrollFallback(element: foundNode.element, app: app, pid: pid, direction: scrollDirection, page: scrollPage, target: target, role: foundNode.role) {
            return emit(encoder, fallback)
        }
        return emit(encoder, ScrollOutput(ok: false, index: target, role: foundNode.role, direction: scrollDirection, page: scrollPage, resolved: nil, error: "AXScroll failed (AXError \(result.rawValue)) and no scrollable frame for fallback"))
    }

    // 后台按路径点菜单
    if let path = menuPath {
        return emit(encoder, pressMenuPath(app: app, path: path))
    }

    // AXPress 后台投递：按快照里的节点 index 重新遍历（索引语义与快照一致），
    // 命中后先校验 role/title 期望，再对元素直接发 AXPress（不动光标、不抢焦点）。
    if let target = pressIndex {
        var found = findNodeIndexed(app: app, target: target, maxDepth: maxDepth)
        if found == nil || (expectRole != nil && found!.role != expectRole!) || (expectTitle != nil && found!.title.contains(expectTitle!) == false) {
            if expectRole != nil || expectTitle != nil, let redo = findNodeByIdentity(app: app, role: expectRole, title: expectTitle, maxDepth: maxDepth, target: target) {
                found = redo
            }
        }
        guard let foundNode = found else {
            return emit(encoder, PressOutput(pressed: false, index: target, role: "", title: "", error: "element not found (index out of range)"))
        }
        if let role = expectRole, foundNode.role != role {
            return emit(encoder, PressOutput(pressed: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), error: "role mismatch: expected \(role), got \(foundNode.role)"))
        }
        if let needle = expectTitle, foundNode.title.contains(needle) == false {
            return emit(encoder, PressOutput(pressed: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), error: "title mismatch: expected to contain \"\(needle)\""))
        }
        let result = AXUIElementPerformAction(foundNode.element, kAXPressAction as CFString)
        let output = result == .success
            ? PressOutput(pressed: true, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), error: nil)
            : PressOutput(pressed: false, index: target, role: foundNode.role, title: String(foundNode.title.prefix(100)), error: "AXPress failed (AXError \(result.rawValue))")
        return emit(encoder, output)
    }

    let appName = stringAttribute(app, kAXTitleAttribute) ?? ""
    let window: AXUIElement?
    if let raw = attribute(app, kAXFocusedWindowAttribute) {
        window = (raw as! AXUIElement)
    } else {
        window = nil
    }
    let windowTitle = window.flatMap { stringAttribute($0, kAXTitleAttribute) }
    let windowFrame = window.flatMap { frameAttribute($0) }

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
            for child in children(of: element).reversed() {
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

func emit<T: Codable>(_ encoder: JSONEncoder, _ value: T) -> Int32 {
    guard let data = try? encoder.encode(value) else {
        FileHandle.standardError.write(Data("ax-snapshot: failed to encode output\n".utf8))
        return 4
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
}

exit(main())
