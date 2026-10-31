// dsh-operator AX snapshot helper（P1-6）
//
// 用 macOS Accessibility API 读一份“最小取证”的 AX 树：只取有 frame 的节点，
// 输出 JSON（节点上限与深度由参数控制），供 Node 侧转成模型可读的文本快照。
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

func main() -> Int32 {
    let arguments = CommandLine.arguments
    var pid: Int32 = 0
    var maxNodes = 120
    var maxDepth = 12
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--pid":
            index += 1
            pid = Int32(arguments[index]) ?? 0
        case "--max-nodes":
            index += 1
            maxNodes = max(1, Int(arguments[index]) ?? 120)
        case "--max-depth":
            index += 1
            maxDepth = max(1, Int(arguments[index]) ?? 12)
        default:
            break
        }
        index += 1
    }
    guard pid > 0 else {
        FileHandle.standardError.write(Data("ax-snapshot: --pid is required\n".utf8))
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
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(output) else {
        FileHandle.standardError.write(Data("ax-snapshot: failed to encode output\n".utf8))
        return 4
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
}

exit(main())
