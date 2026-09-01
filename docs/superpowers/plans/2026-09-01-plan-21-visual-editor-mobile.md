# Realm Plan 21 — The visual component editor: mobile half

> Sibling of Plan 17 (the **web half**). This document owns SwiftUI, Jetpack Compose, Flutter, and the brief
> verdicts on UIKit and React Native. It proposes the shared protocol core that both halves implement; where
> the web half disagrees, the web half wins on shape and this document adapts.
>
> Grounded in four verification passes run against this machine (Xcode 26.6 / Swift 6.3.3, Flutter 3.47 stable,
> Node 22, `adb` 36.0.0) plus `specs/2026-08-28-capability-research.md` §4, whose simulator measurements are
> **still correct and still binding** — this plan does not re-litigate them, it inherits them.
>
> **The one thing to read if you read nothing else:** the three platforms do not differ by degree. Flutter
> hands you a source-located widget tree for free. Compose hands you one for a debug dependency and a
> reflective flag flip. **SwiftUI hands you nothing, at any price, and there is no design that changes that.**
> Ranking the work by anything other than that fact produces a plan that fails at month three.

---

## 0. Feasibility verdict, ranked

| Rank | Platform | Tree + source locations | Tap → select | Live tweak | Source write-back | Verdict | Confidence |
|---|---|---|---|---|---|---|---|
| **1** | **Flutter** | **Free** (`creationLocation`) | **Free** (`show` + `Inspect` event) | Needs a 1-line-per-app dev package | Dart AOT sidecar | **BUILD FIRST** | **High (85%)** |
| **2** | **Jetpack Compose** | Free-ish (debug dep + flag) | Free (bounds ride the tree) | **Needs per-call-site opt-in** | tree-sitter + JVM fallback | **BUILD SECOND** | **High (80%)** |
| **3** | **SwiftUI** | **Impossible without a macro at every `body`** | Only on instrumented views | Only on instrumented views | tree-sitter-swift | **BUILD THIRD, SCOPED DOWN** | **Medium (55%)** |
| — | UIKit | Needs build-time instrumentation anyway | Free | **Free and permanent** | same as SwiftUI | Not worth a separate track | High |
| — | React Native | **Lost.** React 19 deleted `_debugSource` | Free | Ephemeral | Needs our own Babel plugin | **DEFER** | High |

### The SwiftUI problem, stated loudly

**SwiftUI cannot support this feature as specified, and no amount of engineering changes that.** Verified, on this machine:

- A `VStack { Text.font.foregroundColor.padding; Button; Image }` renders as **flat, unnamed, sibling `CALayer`s** in one backing layer. There are zero backing views for `Text`, `Button`, `VStack`, `padding`, or `background`. `hitTest` at the center of the view returns **`nil`**. There is nothing to hit and nothing to name.
- The single runtime introspection API, `_ViewDebug`, is reachable from third-party Swift — and its `Property` enum is `type, value, transform, position, size, environment, phase, layoutComputer, displayList`. **There is no source-location case, and there never has been.** This is the same data Xcode's own view debugger consumes, which is exactly why Xcode cannot jump you to a line either. It also returns `[]` in a normal process; the arming entry point (`_ViewDebug.initialize(inputs:)`) is exported but absent from the `.swiftinterface`, so it cannot be called.
- **`@attached(body)` and `@attached(accessor)` are both rejected on `var body`** — `error: 'body' macro cannot be attached to property ('body')` and `error: variable already has a getter`. SE-0415 says body macros should work on shorthand computed properties; in Swift 6.3.2 they do not ([swiftlang/swift#75715](https://github.com/swiftlang/swift/issues/75715)). **You cannot transparently instrument an unmodified view.**
- **No shipping tool gives SwiftUI source locations.** Not Reveal, not Lookin, not SwiftUI-Introspect (whose README explicitly cannot see `HStack`/`VStack`/`Text`/`Image`/`Spacer`), not FLEX, not ViewInspector. This is the state of the art, not a gap someone forgot to fill.

So the SwiftUI design is **opt-in compile-time instrumentation**: `var body: some View { #realm { … } }`, one line per view, and **zero coverage on any view the developer did not annotate** — including every system control and every third-party library. If we ship a SwiftUI story it must say that in the product UI, not in a footnote. A user who taps an uninstrumented `Button` must see "this view is not instrumented — add `#realm`", never an empty inspector.

The compensating discovery, and it is a real one: **Apple ships a working in-process literal-patch channel that we can use without Xcode.** `__designTimeApplyIncrementalValues(_:)` is `public` in `DeveloperToolsSupport` (a module compiled `-library-level api`) and in `SwiftUI`, iOS 13+. Verified running with no Xcode attached, no preview host, no debugger: `padding 8 → 40`, `title "Hello" → "PATCHED LIVE"`, `opacity 1.0 → 0.25`. Keys are **arbitrary strings** (no `#NNNN.[0]` format required), semantics are **merge-and-persist**, and repeated partial updates accumulate. Two traps: the argument must be *explicitly typed* `[[String: Any]]` or it silently resolves to the other module's overload and **no-ops with no error**; and patching **does not invalidate the SwiftUI graph** — verified, `fittingSize` stayed `(29,32)` until an explicit invalidation, then jumped to `(305,112)`.

**We will not depend on it.** It is double-underscored, undocumented, and a plausible App Store review flag. Our default is a plain dictionary in our own module with an observable generation token; `__designTime*` is an optional interop bonus behind `#if DEBUG`. But its existence proves the mechanism is sound and gives us a reference for the semantics.

---

## 1. Architecture

Three platforms, three completely different acquisition mechanisms, **one protocol**. The adapter layer lives in realm-server; the pane never learns which platform it is looking at.

```
┌── renderer ────────────┐   RPC: inspect.*      ┌── realm-server ──────────────────┐
│  InspectorPane         │◄─────────────────────►│  InspectSession (per attached app)│
│  (Figma-style panel)   │   events: inspect.*   │   ├ FlutterAdapter  → VM Service  │
│  SimulatorPane (opt.)  │                       │   ├ ComposeAdapter  → agent socket│
└────────────────────────┘                       │   ├ SwiftUIAdapter  → agent socket│
                                                 │   └ WriteBack (locate→splice)     │
                                                 └──────────┬───────────────────────┘
                                                            │ writes files
                                                   workspace.changed ──► DiffPane
```

**Ownership.** realm-server, not Electron main. Unlike the browser pane there is no `WebContentsView` and no CDP — every channel here is a plain socket realm-server can hold. Main is only involved if the simulator pane is built (W9), and even then only for the video decode path.

**Direction asymmetry, and why it matters.** On Flutter, **Realm is the client** — it dials the app's VM Service. On Compose and SwiftUI, **the app is the client** — the runtime agent dials Realm. The adapter hides this, but two things leak and must be designed for: Flutter needs `flutter run` to stay alive, and Compose/SwiftUI need a port the app can reach. iOS Simulator shares the host loopback, so `127.0.0.1:PORT` just works. Android emulator does not: **realm-server runs `adb reverse tcp:PORT tcp:PORT`** on attach and tears it down on detach. Physical devices are out of scope for v1 (iOS needs mDNS + a macOS Local Network grant, and mDNS on Simulator broke in macOS 15.4 — Flutter's own `attach.dart` carries a comment about it).

**The commit path is already built.** Write-back writes files in the environment's checkout. `workspace.changed` fires. The diff pane the user already has refreshes and shows the edit. We add no diff UI. This is the whole reason the feature belongs in Realm rather than in an IDE plugin.

---

## 2. The shared protocol — `realm-inspect/v1`

Proposed as the **common core** for both halves. The web half's CDP adapter, the Flutter VM-service adapter, and the Compose/SwiftUI socket agents all produce these shapes. Named and doc-commented per `contracts/rpc.ts` conventions.

```ts
/** Where a node came from in source. `span` is a byte-exact range when the platform can give one
 *  (Compose emits a UTF-16 offset+length; the web half gets one from sourcemaps); null when the
 *  platform only knows line/column (Flutter, SwiftUI) and the write-back locator must resolve it. */
export const SourceOriginSchema = z.object({
  file: z.string(),                 // ABSOLUTE path, resolved against the environment's checkout
  line: z.number().int(),           // 1-based
  column: z.number().int(),         // 1-based
  span: z.object({ offset: z.number().int(), length: z.number().int() }).nullable(),
  /** False when the file is outside the project (a package, the framework). Drives the "you are
   *  editing someone else's source" refusal — Flutter's `createdByLocalProject`, generalized. */
  inProject: z.boolean(),
});

/** One inspectable property. `type` is the EDITOR kind, not the language type — the inspector
 *  renders a slider for `number`, a swatch for `color`, a 4-up box for `insets`. `opaque` is the
 *  honest one: we can display it and we cannot edit it. */
export const InspectPropSchema = z.object({
  name: z.string(),
  group: z.enum(["layout", "spacing", "color", "text", "other"]),
  type: z.enum(["number", "color", "string", "bool", "enum", "insets", "opaque"]),
  /** Typed value when the platform gives one; null when only `display` is known. */
  value: z.unknown().nullable(),
  /** What to show when `value` is null — the source expression, a named constant, an enum case. */
  display: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  editable: z.boolean(),
  /** Human-readable, shown verbatim in the inspector. Naming lifted from the Dart analysis server's
   *  `notEditableReason` — the one prior art that got this right: the SERVER explains the refusal,
   *  the client never guesses. */
  notEditableReason: z.string().nullable(),
});

export const InspectNodeSchema = z.object({
  id: z.string(),                   // agent-minted, stable for the attach session
  parentId: z.string().nullable(),
  kind: z.string(),                 // "Padding", "Column", "Text", "VStack", "div"
  label: z.string().nullable(),     // text preview / semantics label
  /** Root-relative, in DEVICE-INDEPENDENT points, never pixels. Every platform reports points and
   *  every capture path reports pixels; the conversion happens once, here. */
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  origin: SourceOriginSchema.nullable(),
  props: z.array(InspectPropSchema),
});
```

Methods and events, following `browsers.*` / `browser.*` precedent:

```ts
"inspect.list":   { params: {}, result: z.array(InspectTargetSchema) }        // discovered runnable apps
"inspect.attach": { params: { spaceId, environmentId, targetId }, result: { inspectId, platform } }
"inspect.detach": { params: { inspectId }, result: { ok: true } }
"inspect.tree":   { params: { inspectId, rootId: nullable }, result: { nodes: InspectNode[] } }
"inspect.setSelectMode": { params: { inspectId, enabled: boolean }, result: { ok: true } }
"inspect.select": { params: { inspectId, nodeId }, result: { ok: true } }     // desktop → device
/** Live preview. NEVER writes source. `value` null reverts this one prop. Returns `applied: false`
 *  with a reason rather than throwing — an un-tweakable prop is a state the panel has words for. */
"inspect.tweak":  { params: { inspectId, nodeId, prop, value: unknown.nullable() },
                    result: { applied: boolean, reason: string.nullable() } }
"inspect.revertAll": { params: { inspectId }, result: { ok: true } }
/** Accept. Resolves each pending tweak to a byte range, splices, writes, and lets workspace.changed
 *  carry it to the diff pane. Partial success is the normal case and is reported per prop. */
"inspect.commit": { params: { inspectId, nodeIds: string[] },
                    result: { edits: CommitEditSchema[], refused: CommitRefusalSchema[] } }

"inspect.treeChanged": { inspectId }                 // coalesced; client re-fetches
"inspect.selected":    { inspectId, nodeId: nullable }
"inspect.status":      { inspectId, state: "attached"|"reloading"|"lost", detail: nullable }
```

Three protocol decisions worth defending:

1. **Flat node list, parent pointers, client builds the tree.** Same reason the browser pane refs by `backendNodeId`: a nested payload cannot be diffed cheaply, and Compose's tree walk is expensive enough that we send it once and patch.
2. **`inspect.tweak` and `inspect.commit` are separate calls, and tweak can never write.** This is the invariant that makes the feature safe to drag. A slider fires dozens of tweaks a second; exactly zero of them touch disk.
3. **Refusals are data, not errors.** Every platform will refuse the majority of interesting props (§7). The panel must render a greyed row with an explanation, not an empty panel or a thrown toast.

---

## 3. W1-W3 — Flutter (ships first)

### W1 — Read-only inspector, no app changes

The tree, source locations, selection, and screenshots all come from the VM Service with **zero code added to the user's app**. The official `dart mcp-server` already does exactly this architecture, which is the strongest possible evidence it works.

**Discovery.** `flutter run --vmservice-out-file=<path>` writes the ready-to-use `ws://…/ws` URI — it writes `wsAddress`, not `httpAddress`, so no string surgery. Prefer this when Realm spawns the process. When attaching to an app Realm did not launch, `dart tooling-daemon --list` → connect to DTD → `getVmServices()`. **Do not scrape stdout** ("A Dart VM Service on … is available at:" is a device-lab-parsed line and gives you the *HTTP* address). There is no `.dart_tool/` service-info file for `flutter run` — `--write-service-info` was proposed ([flutter#41106](https://github.com/flutter/flutter/issues/41106)) and never adopted.

**DDS is present and it is good news.** `flutter run` starts DDS and *"direct connections to a VM service with an active DDS instance attached will be rejected."* That is precisely what lets Realm connect **simultaneously with DevTools and the user's IDE** — no eviction, unlike React Native below. DDS also replays stream history on the `Extension` stream, so we do not miss `Flutter.Frame`/`Flutter.Navigation` events emitted before we attached.

**The tree.** `ext.flutter.inspector.getRootWidgetTree` with `{ groupName, isSummaryTree, withPreviews, fullDetails }` — this is the modern call that supersedes `getRootWidget` / `getRootWidgetSummaryTree` / `…WithPreviews`, and it is what current DevTools and the Dart MCP server use. Scope with `addPubRootDirectories` (`setPubRootDirectories` is the one deprecation: *"deprecated after v3.18.0-2.0.pre"*).

**Source locations.** `creationLocation` → `{ file, line, column, name }`, 1-based line and column. `--track-widget-creation` **defaults to true** and is JIT/debug-only. `--no-track-widget-creation` breaks everything: `isWidgetCreationTracked()` goes false, the summary tree collapses, `createdByLocalProject` is never set, and `widgetLocationIdMap` is not even registered. Two handling notes: **`file` is a URI, not a path** — always `Uri.parse` it, never `substring(7)`, because `--filesystem-scheme` and web produce `org-dartlang-app:///`. And **`parameterLocations` does not exist** — removed by [flutter#84461](https://github.com/flutter/flutter/pull/84461) in 2021. Any doc mentioning it is five years stale.

`widgetLocationIdMap` returns a columnar `{ fileUri: { ids, lines, columns, names } }` index — build the source↔widget map from it once rather than walking the tree.

**Selection.** `ext.flutter.inspector.show { enabled: true }` turns on the on-device select overlay with **no app code change** — `WidgetsApp.build` auto-wraps in a `WidgetInspector` off `debugShowWidgetInspectorOverrideNotifier`. **There is no `Flutter.SelectedWidget` event.** On tap, `_notifyToolsOfSelection` does exactly two things: `developer.inspect(object)`, which fires an **`Inspect` event on the `Debug` stream**, and `postEvent('navigate', {fileUri, line, column, source}, stream: 'ToolEvent')`. So: `streamListen('Debug')`, `streamListen('ToolEvent')`, `streamListen('Extension')`; on `Inspect`, call `getSelectedSummaryWidget`. `setSelectionById` echoes back through the same path — **we need DevTools' de-dup** (it uses a 5000 ms window against [flutter#39366](https://github.com/flutter/flutter/issues/39366)) or desktop→device selection ping-pongs.

**The real cost in W1, and it is not small: property values come back as strings.** `DiagnosticsProperty.toJsonMap` emits a typed `value` **only for `num`, `String`, `bool`, and `null`**. A `Color`, `EdgeInsets`, `TextStyle`, `Alignment`, or any enum arrives as a `description` string plus `propertyType` and `valueId`. A Figma-style inspector is *entirely* about colours and insets, so W1 includes a parser for `"Color(0xff2196f3)"`, `"EdgeInsets.all(8.0)"`, `"EdgeInsets(8.0, 4.0, 8.0, 4.0)"` and friends, with `type: "opaque"` as the honest fallback. Escape hatch for the hard cases: `valueId` is an inspector object-group id, so `evaluate("WidgetInspectorService.instance.toObject('inspector-42')")` yields a real `InstanceRef` — but that needs `flutter run` alive and costs a round trip.

**Everything here is `assert`-gated.** Debug builds only; in profile and release the entire surface is stripped. Fine — this is a dev tool — but the pane must detect it (`isWidgetTreeReady`, `isWidgetCreationTracked`) and say "run a debug build" rather than showing an empty tree.

**Effort: 4-6 days.** Confidence high. The unknown is entirely the property-string parser's long tail.

### W2 — Write-back

**Do not use the Dart analysis server's property editor for this.** It is the obvious idea and it does not cover our case, verified against a real `flutter create` project:

- `dart/textDocument/editableArguments` returns only params whose type is `double`, `int`, `bool`, `String`, or an enum. `handler_editable_arguments.dart` ends with `else { /* TODO(dantup) */ return null; }` — **`EdgeInsetsGeometry` and `Color` fall in the `else` and are omitted entirely.** On a `Container` it returned `width`, `height`, `clipBehavior` and nothing else.
- `editArgument`'s `newValue` is a *typed value*, not an expression. Sending `'const EdgeInsets.all(24)'` returns `{"code":-32019,"message":"The value for the parameter 'padding' should be EdgeInsetsGeometry? but was String"}`.
- Nesting does not save us: `getInvocationInfo` walks **up** to `node.isWidgetCreation`, so a cursor inside `EdgeInsets.all(16)` resolves to the enclosing `Padding`, not the `EdgeInsets`.
- The legacy `flutter.setWidgetPropertyValue` *does* decompose padding into doubles — and returned a **207-byte replacement spanning the whole enclosing method body**, collapsing whitespace on untouched siblings, re-indenting, joining `child:` onto one line, dropping `const`, and rewriting `.all` → `.only`. Categorically incompatible with a byte-exact diff.

**What we build instead: a Dart AOT sidecar that only ever returns offsets.** `dart compile exe` over `package:analyzer`, taking `(file, line, col, paramName)` and emitting `{kind, offset, length, text}`. Measured: **6.8 MB binary, ~10 ms startup, zero runtime dependencies** (verified under `env -i`). Node does the splice. Proof on a file with a deliberate triple space and a decoy `margin: EdgeInsets.all(16)` carrying the identical literal: `cmp -l` reported **exactly two bytes changed** in 360.

Pin the `analyzer` version to what the **user's** Flutter SDK resolves — analyzer 13.0.0 replaced `NamedExpression` with `NamedArgument`, and analyzer 14.3.0 needs Dart ^3.11. Resolve `<flutter>/bin/cache/dart-sdk` from the real `flutter` binary; never trust `dart` on `PATH` (fvm/asdf/mise shims are the norm).

Keep the analysis server around as a **diagnostic oracle only** — `editableArguments`' `isEditable`/`notEditableReason` is a free, authoritative source of refusal text for the scalar cases. Never as the writer.

**Effort: 4-5 days.**

### W3 — Live tweak: the `realm_tweaks` dev package

Flutter ships exactly one runtime-mutation API and it covers four properties: `setFlexFit`, `setFlexFactor`, `setFlexProperties` mutate `FlexParentData`/`RenderFlex` and `markNeedsLayout()`. The docs are blunt about the semantics: *"Widget property changes made from the layout explorer don't modify your source code and are reverted on hot reload."* Good proof-of-concept, useless as a general mechanism.

Hot reload is **not** the drag loop: Flutter's own CI benchmarks are ~400 ms, regressed to ~670 ms ([flutter#171722](https://github.com/flutter/flutter/issues/171722)); the docs' worked example is `Reloaded 1 of 448 libraries in 978ms`. That is the *commit* path, not the *drag* path.

So: a small dev-only pub package the user adds, using the fully public `dart:developer.registerExtension`:

```dart
class RealmTweaks {
  static final instance = RealmTweaks._();
  final _overrides = <int, Map<String, Object?>>{};   // locationId -> {param: value}
  T? get<T>(int locationId, String param) => _overrides[locationId]?[param] as T?;

  void install() { assert(() {
    developer.registerExtension('ext.realm.tweak', (m, p) async {
      _overrides.putIfAbsent(int.parse(p['locationId']!), () => {})[p['param']!] =
          jsonDecode(p['value']!);
      notifyListeners();                       // targeted rebuild, sub-frame
      return developer.ServiceExtensionResponse.result('{"ok":true}');
    });
    developer.registerExtension('ext.realm.revertAll', ...);
    return true; }());
  }
}
```

The key that makes this practical: **`locationId` is already ours.** It is minted by `_toLocationId(creationLocation)`, returned on every tree node as `result['locationId']`, and fully indexed by `widgetLocationIdMap`. The desktop can address "the `Padding` on `main.dart:42`" with no AST identity scheme.

The honest cost is the same one the SwiftUI and RN designs hit independently: **each overridable call site needs a wrapper**, or a build step that inserts one. For v1 we ship the package with wrapper helpers and accept partial coverage; the drag loop works where the developer opted in, and everywhere else the panel degrades to "edit and hot reload" with the 400-1000 ms latency shown honestly in the UI.

**Effort: 3-4 days.**

---

## 4. W5-W6 — Jetpack Compose

### W5 — Read-only inspector

Compose is the pleasant surprise: **the compiler already emits source locations into the binary**, and the API to read them is public.

**The source-information string is real and its grammar is documented in androidx source** (`runtime/tooling/SourceInformation.kt` — it moved *into the runtime* in Compose 1.9):

```
call-section := "C" [ "C" ] [ "(" <function-name> ")" ]      -- CC = inline call
location     := [ "*" ] [ <line> ] "@" <offset> [ "L" <length> ]   -- * = repeatable (loop)
source-info  := call-section section* locations? ":" <file-name> [ "#" <package-hash> ]
```

Real strings: `C(Home)57@262L139:main.kt#1wrmn`, `CC(Column)N(content):main.kt#1wrmn`, `C(ttt)N(lll)38@158L14,*38@183L10:main.kt#dgdy5s`. Note the semantic that matters: **a group's location list describes where its CHILDREN were called from**, which is exactly the "jump to the call site" behaviour we want.

**It is on by default in debug and stripped from minified release.** The Kotlin Compose Gradle plugin's `includeSourceInformation` has `.convention(true)`; AGP 8.5 gated it on `getDebuggable()`, AGP 8.11 adds it unconditionally. And R8 removes it — verbatim from the shipping `runtime-android` AAR's `proguard.txt`:

```
-assumenosideeffects public class androidx.compose.runtime.ComposerKt {
    void sourceInformation(androidx.compose.runtime.Composer,java.lang.String);
    void sourceInformationMarkerStart(androidx.compose.runtime.Composer,int,java.lang.String);
    void sourceInformationMarkerEnd(androidx.compose.runtime.Composer);
}
```

Perfect for a dev-only library, and the pane must detect the stripped case and say so.

**The reader is `androidx.compose.ui:ui-tooling-data`** — published on Google Maven, everything public behind one `@UiToolingDataApi` opt-in. `SourceLocation(lineNumber, offset, length, sourceFile, packageHash)` — and **`offset`/`length` are UTF-16 offsets into the file**, which is a byte-exact `span` for our protocol and makes Compose the *easiest* write-back target of the three despite being the second-hardest to read.

**Do not use `asTree()`.** bitdrift measured ~800 ms for >65 nested views in JetNews; androidx's own release note for `mapTree` says *"a performance improvement of about a factor 10."* Use `makeTree` on Compose 1.11+ (it stitches sub-compositions — dialogs, popups — via `CompositionInstance` parentage) or `mapTree` per `CompositionData` below that, always with a shared `ContextCache`, always on demand and never on a frame callback.

**Getting the slot tables**, without JVMTI, without Studio, without `androidx.inspection` (neither `ui-inspection` nor `inspection` is published to Maven — Studio injects them):

```kotlin
// Before any composition. Reflectively, so R8 cannot constant-fold it — androidx's own comment
// on this exact trick: "This allows the InspectorInfo lambdas to be stripped from release builds."
Class.forName("androidx.compose.ui.platform.InspectableValueKt")
    .getDeclaredField("isDebugInspectorInfoEnabled")
    .apply { isAccessible = true }.setBoolean(null, true)
```

That single flag makes `Wrapper.setContent` create the `inspection_slot_table_set` tag on every `AndroidComposeView` for us, and un-gates `debugInspectorInfo { }` — which is what makes `Modifier.padding(16.dp)` and `Modifier.background(color)` report their values through `InspectableValue.inspectableElements`. Discover roots via `decorView.flatten().filterIsInstance<ViewRootForTest>()` (`AndroidComposeView` is internal but implements that public interface — Radiography and PostHog both rely on this in production). Any root composed before we flipped the flag is repopulated by `androidx.compose.runtime.simulateHotReload(context)`, then `disableHotReloadMode()` — public top-level functions since Compose 1.7.0, annotated only with the lint-only `@TestOnly`.

**Hit testing** is on our own tree: `Group.box` is in window coordinates, so descend picking the deepest child containing the tap that carries a non-null `SourceLocation`, tie-breaking on smallest area. `LayoutNode.hitTest` and `HitTestResult` are internal; the semantics tree is 1-2 orders of magnitude faster but **has no source locations and cannot see a bare `Box(Modifier.padding(8.dp))`** — use it only to enrich (text, role, testTag) via the `SemanticsNode.layoutInfo.semanticsId` ↔ `(NodeGroup.node as LayoutInfo).semanticsId` join.

Prior art that proves the path: **Flipper's jetpack-compose plugin vendored androidx's `LayoutInspectorTree` and shipped `filename`, `lineNumber`, `offset`, `length` to a desktop UI over a socket** — exactly our architecture. It was **archived 2025-09-26**, which is why we build it rather than depend on it. Radiography collects `SourceLocation` today and never renders it (`ScannableView.CallGroupInfo`), so its collection path is a working reference.

**Effort: 5-7 days.**

### W6 — Live tweak and write-back

**There is no API to override a composable's parameter from outside. This is settled, not a gap.** Confirmed three ways: the Layout Inspector protocol (`compose_layout_inspection.proto`, 464 lines, Apache-2.0, public) has **zero write commands** — `UpdateSettingsCommand` only toggles recomposition counting; parameters live on the stack of an invocation; and `HotReloader.invalidateGroupsWithKey` merely re-runs the *same bytecode with the same literals*. Live Literals (`updateLiveLiteralValue`) still ships and would work — but it needs a non-DSL compiler flag, a per-file `enabled` boolean flipped by reflection, the same flag on every dependency including Material, and Studio has deprecated its own UI for it.

So Compose gets the same shape as Flutter and for the same reason: **call-site opt-in.**

```kotlin
Box(Modifier.tweakable("card").padding(16.dp))
```

A custom `ModifierNodeElement` reading a `MutableState` from our registry — real, instant, correctly-recomposing edits with no compiler flag. Alongside it, read the *current* values off `InspectableValue.inspectableElements` so the panel can **display** everything and **edit** the opted-in subset. Datadog's `ComposeReflection.kt` (`PaddingElement.start/end/top/bottom`, `BackgroundElement.color/shape/brush/alpha`, `GraphicsLayerElement.shape`) is the reference for the harder reads.

**Write-back**: tree-sitter-kotlin WASM (`@tree-sitter-grammars`, ABI-14, loads in `web-tree-sitter` 0.27) as the locator, with the Compose `SourceLocation.offset/length` as the anchor so we never have to search. Two verified hazards: the grammar **cannot parse context parameters** (`context(logger: Logger)` — **stable as of Kotlin 2.4.0**, so it will appear), and **error recovery cascades forward** — an unparseable construct *before* the target yields 0 matches (safe: no match, never a wrong offset), the same construct *after* is harmless. Gate hard on `tree.rootNode.hasError === false`, and fall back to a **Java** sidecar over `kotlin-compiler-embeddable` PSI via `KtLintRuleEngine.transformToAst()`. Java, not Kotlin: `KotlinCoreEnvironment.createForProduction` now carries `@K1Deprecation`, which is `@RequiresOptIn(ERROR)` and therefore **enforced only by the Kotlin compiler** — calling it from Java compiles clean. Measured JVM sidecar cost: 274-335 ms env init, 0.61 ms warm parse, 359-435 ms total process wall including JVM boot. Byte-exact round-trip verified, comments and whitespace retained.

Note ktlint moved (`pinterest/ktlint` → `ktlint/ktlint`, group id `io.github.ktlint.core` — the changelog's stated coordinate is wrong) and ktfmt moved to JetBrains and is whole-file-in/whole-file-out, i.e. unusable.

**Effort: 5-7 days.**

---

## 5. W7-W8 — SwiftUI, scoped down

Read §0 first. This work item builds the only design that can exist.

**The macro.** Freestanding expression, at the body site, opt-in, one line:

```swift
var body: some View { #realm { VStack { Text("Hi").padding(8) } } }
```

Attached macros are ruled out by the compiler (verified). A freestanding expression macro can run a `SyntaxRewriter` over its argument and works — verified end to end, `.padding(8)` rewritten to `.padding(Realm.number(key: "…", 8))` with the override taking effect at runtime.

**The location trap, and its fix.** Inside a freestanding macro, `context.location(of:)` **returns the macro-expansion site for every sub-node** — all `.padding` calls reported the identical `main.swift:6:13`. Fix is arithmetic: take the expansion-site line once, then count newlines in the argument text before each node's `positionAfterSkippingLeadingTrivia`. Verified to produce distinct, monotonic per-modifier lines with a constant off-by-one calibrated once. Budget a day for getting this exactly right; it is the load-bearing correctness property of the whole SwiftUI track.

**Macros are purely syntactic** — no types, no cross-file visibility. `#realm` can recognise `.padding(8)` lexically but **cannot know the receiver is a `View`**. Whitelist modifier names; accept that false positives cannot be fully ruled out.

**The macro emits a compile-time manifest** of every key → `(file, line, column, modifier, default)`. **This manifest IS the view tree.** It is the only place source locations can come from, and this is the inversion that makes the design work: on SwiftUI, compile time produces the tree and runtime only reports geometry and applies patches.

**Runtime**: each instrumented node appends `.modifier(RealmNode(key, type:))`, which reports its rect via `.anchorPreference(key:value:.bounds)` + `GeometryProxy[anchor]` (or `onGeometryChange` on iOS 18+) into a named coordinate space. Selection is **our own overlay hit-tested against collected rects**, innermost-containing-rect wins. **Never hit-test SwiftUI's layers** — verified to return `nil`.

**Tweaks**: `Realm.number/color/font(key, default)` reads a plain store, and instrumented nodes depend on an **observable generation token**. The token is not optional — verified, patching the store without invalidation is a silent no-op. Mirror writes into `__designTimeApplyIncrementalValues` behind `#if DEBUG` for Xcode-preview interop, as a bonus, never as the mechanism.

**What we explicitly cut and say out loud in the product:** uninstrumented views, all system controls, all third-party libraries, and any value that is not a literal argument at the recorded site. The honest scorecard is **~80% of the feature on 100% of opted-in views and 0% elsewhere**, and the second column cannot be improved.

**We do not build on Inject/InjectionIII.** It needs a companion macOS app, `-Xlinker -interposable` on every Debug target, `EMIT_FRONTEND_COMMAND_LINES=YES`, and per-view `@ObserveInjection` + `.enableInjection()`. For "change a padding value" that is a sledgehammer; our own store does the same job in-process. Reserve it as a documented option for structural changes.

**Write-back**: tree-sitter-swift WASM — **3.8 MB, from the GitHub release 0.7.3 asset, not npm.** The npm package ships 72 MB of native prebuilds, no `.wasm`, is 14 months stale, and has a peer-dep conflict (`tree-sitter-swift@0.7.1` pins `tree-sitter@^0.22.1`, so installing alongside 0.25 fails ERESOLVE). The grammar is healthy — commits landed today, parsed a realistic SwiftUI file with `@State`, `ForEach`, string interpolation with emoji, and chained modifiers in **0.97 ms with `hasError = false`**. Queries must be anchored to exactly one unlabeled argument or `.padding(.horizontal, 16)` and `.frame(width: 16)` false-positive.

An optional swift-syntax sidecar remains available as a high-fidelity validator: 17 MB unstripped / ~6 MB stripped, 0.86 ms warm parse, **byte-exact round-trip on all 11 adversarial cases** including syntactically broken source, and — verified — **zero `@rpath` dependencies**, so end users need neither Xcode nor a Swift toolchain. It costs a 4.6-minute CI build and a `mac.sign.binaries` entry alongside the existing `scrollphase` helper. Add it only if structural `SyntaxRewriter` edits become necessary.

**Effort: 10-15 days, high variance.** This is the one number in the plan I would not defend to ±30%.

---

## 6. W9 — The simulator pane (optional, and deliberately last)

**The visual editor does not need it.** The runtime agent draws its selection overlay *on the device*; `ext.flutter.inspector.show` already ships an on-device select mode; the inspector panel is a Realm pane and the diff pane is a Realm pane. A user with Xcode's simulator window open beside Realm gets 60 fps, real touch, and a debugger for zero days of work. **Ship W1-W8 against that setup.** The pane only wins when the agent's actions and the device view belong in the same recorded transcript — a real benefit, and a later one. This preserves the capability-research verdict (§4: DEFER, 8-12 d) rather than overturning it.

If and when it is built, one finding **overturns** the old research and one confirms it.

**Overturned: `idb` is not abandoned.** `facebook/idb` is MIT, `archived: false`, **v1.5.2 released 2026-09-01**, companion rewritten in pure Swift on grpc-swift + SwiftNIO, with recent commits adding `idb video --fps/--scale-factor/--bitrate`. And we should not shell out to it at all — `idb_companion` **is a gRPC server**:

```
idb_companion --udid <UDID> --grpc-domain-sock /tmp/realm-sim.sock
```

consumed from Electron main with `@grpc/grpc-js` over a `unix:///…` target. `video_stream` yields **Annex-B H.264** (`VideoStreamRequest.Start` carries fps, format, compression_quality, scale_factor, avg_bitrate, key_frame_rate), which goes straight into the renderer's `VideoDecoder` — per the WebCodecs AVC registration, *"if the `description` is not present, the bitstream is assumed to be in `annexb` format."* `hid(stream HIDEvent)` carries touch, button, key, swipe, pinch, delay, orientation, shake. `accessibility_info` with `--api axbridge-persistent` is **~20 ms warm** vs ~600 ms for the spawn-per-read backend. **Latency is UNVERIFIED — measure before committing.**

**Confirmed, with new evidence:** every simple route is still dead. `simctl io … recordVideo --codec h264 -` now returns verbatim *"Error: rendering to standard out is no longer supported"*; a FIFO yields 0 bytes; `screenshot -` writes a file literally named `-`; ten back-to-back screenshots took 6.32 s (**1.58 fps**) and a bare `simctl list devices booted` costs 0.78 s, so *any* per-invocation `simctl` design is dead on arrival. `simctl device_appeared` **does not exist**. And `CGWindowListCreateImage` is now `SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0)` — it will not compile against a modern SDK — while ScreenCaptureKit is purely TCC-gated on top of Xcode 27 removing Simulator.app for DeviceHub.

**Android**: scrcpy via Tango (`@yume-chan/adb` + `@yume-chan/scrcpy` + `@yume-chan/scrcpy-decoder-webcodecs`, MIT, actively maintained) — one code path for emulators and real devices, 35-70 ms on hardware and worse on an AVD (software encoder). Alongside it, the **official emulator gRPC** for what scrcpy cannot do (GPS, battery, clipboard, sensors, fold posture): read `grpc.port` (default 8554) and `grpc.token` from `~/Library/Caches/TemporaryItems/avd/running/pid_<PID>.ini`, insecure channel plus `authorization: Bearer <token>`. **No Envoy needed** — Envoy exists in the container scripts only because browsers cannot speak raw gRPC, and Electron main is Node. Do **not** depend on `android-emulator-webrtc` 2.x; its rewrite now targets an "Emulator Gateway" you would have to run.

**Effort: 8-12 days, unchanged.**

---

## 7. Write-back: the one invariant, and the refusal list

**The parser never writes the file.**

```
locate(file, hint) -> { start, end }        // the parser's only job
splice in Node     -> src.slice(0,start) + newText + src.slice(end)
reparse            -> assert no errors; assert length delta == expected
```

Everything outside `[start, end)` is byte-identical *by construction*. "Preserves formatting" stops being a property we trust a pretty-printer for and becomes a property of the algorithm. This is why Dart's `unit.toSource()` not round-tripping does not matter, and why **we never run a formatter afterward** — `dart format`, `ktfmt`, and `swift-format format` all discard the entire point. (`swift-format --offsets start:end`, whose unit matches `utf8Offset`, is the one safe exception.)

**Offset units, verified, and the trap nobody tests:**

| Source | Unit | Slice with |
|---|---|---|
| tree-sitter (native and WASM) | UTF-16 code units | `String.slice` |
| Dart `analyzer` `AstNode.offset` | UTF-16 | `String.slice` |
| Kotlin PSI `getTextRange()` | UTF-16 | `String.slice` |
| Compose `SourceLocation.offset` | UTF-16 | `String.slice` |
| **swift-syntax `position.utf8Offset`** | **UTF-8 bytes** | **`Buffer.subarray`** |

Verified on a file containing 🎉: node reported `[157..161)`; `src.slice` → `"(16)"` ✅, `buf.subarray` → `"ng(1"` ❌. `Text("🎉")` makes this a live hazard on every platform, not a theoretical one.

Flutter is the exception that needs conversion: `creationLocation` is **1-based line/column, per-widget, not per-argument** — convert via `LineInfo.getOffsetOfLine(line-1) + (col-1)` and let the sidecar walk to the argument.

### What CANNOT be safely edited — refuse, do not guess

Every one of these renders as a greyed row with the reason, plus a "jump to source" action.

**Hard refusals — the literal is not there:**

- **Computed values.** `.padding(base * 2)`, `EdgeInsets.all(spacing + 4)`, `16.dp * scale`.
- **Named constants and design tokens.** `.padding(Spacing.medium)`, `EdgeInsets.all(kDefaultPad)`, `Modifier.padding(MaterialTheme.spacing.md)`. **The most dangerous case, because it looks editable** — the literal lives in another file and is shared, so editing it silently changes every other call site.
- **Theme/environment lookups.** SwiftUI `@Environment`, Compose `MaterialTheme.*`/`LocalDensity`, Flutter `Theme.of(context)`. The value is not in source at all.
- **Values inside loops / `ForEach` / `LazyColumn`.** One source site, N rendered instances. Compose even marks these — the `*` prefix in a source-info location literally means "repeatable". The user tweaked one; we cannot express that without a structural change.
- **Values under conditionals.** `.padding(isCompact ? 8 : 16)`. Which branch was live is a *runtime* fact the parser does not have.
- **Shared modifier extensions / view modifiers.** `extension View { func cardStyle() }`, `fun Modifier.cardStyle()`. Same shared-mutation hazard, plus the creation location points at the *call*, not the definition.
- **Adjacent strings, interpolated strings, strings containing newlines.** Lifted verbatim from the Dart analysis server's own refusal set, which got there the hard way.

**Soft refusals — locatable, but ambiguous:**

- Multiple identical literals in one chain (`.padding(16).cornerRadius(16)`) without an anchored query plus a runtime hint.
- Macro- or codegen-produced source: `@freezed`, `build_runner`, KSP output, `#Preview`. Edits are discarded on regeneration.
- Flutter constructors the transform skipped — the SDK doc says `--track-widget-creation` *"will silently skip any constructor that declares optional positional parameters"*, and `CreationLocation.of` returns null. No location, no edit.
- Positional parameters that cannot be added: *"A value for the Nth parameter can't be added until a value for all preceding positional parameters have been added."*
- **Files with unsaved editor buffers.** We would splice against stale bytes — hash before and after.

**The rule:** auto-edit only when the runtime location resolves to a **single literal token, in a single non-shared source site, with no operators between it and the parameter.** Everything else is a navigate-to-source action, not a write.

---

## 8. React Native — DEFER, and say why

Brief because the answer is short and bad.

**React 19 deleted `_debugSource`** ([facebook/react#28265](https://github.com/facebook/react/pull/28265), "Remove `__self` and `__source` Location from Elements"). Verified by tag: 4 occurrences in `react-reconciler` at 18.3.1, **0 at 19.0.0**. RN 0.78 moved to React 19, so **every RN from 0.78 onward has no per-node source location.** The replacement, owner stacks / `captureOwnerStack`, carries React's own accuracy caveat: *"This won't point to the top of the component function but it's at least somewhere within it."* **Not precise enough to write back to a specific JSX attribute.** We would ship our own Babel plugin — i.e. the same build-time instrumentation as SwiftUI, on a platform where Flutter and Compose both give it for free. (Plan 17 reaches the identical conclusion for the web, independently, which is itself corroborating.)

Three more walls: **port 8097 was removed in RN 0.87** ("Remove support for connecting to the standalone `react-devtools` package via WebSocket"); **Hermes CDP has no DOM, CSS, or Overlay domains** — grepping every agent for `"DOM.`/`"CSS.`/`"Accessibility.` returns zero hits, and the only `Overlay` method is a paused-in-debugger banner; and **`supportsMultipleDebuggers` requires RN ≥ 0.85**, below which attaching *evicts the user's own DevTools* with `[NEW_DEBUGGER_OPENED]` — a product-killing UX bug with no workaround.

What is genuinely good, for whenever this thaws: Fabric's `getBoundingClientRect(node, includeTransform)` is **transform-aware**, which is better geometry than either Flutter or Compose gives us; `__EXTERNAL_INSPECTION__` (new in 0.85, on by default) exists *specifically* so an external tool can drive the on-device inspector overlay; and `Page.captureScreenshot` landed in 0.86. But `overrideValueAtPath` mutates `fiber.pendingProps`, so **the next parent re-render silently discards the edit** — same failure as Flutter's `setFlexProperties`, and the same conclusion: runtime override is a drag-preview mechanism, never a persistence story.

**UIKit** gets a paragraph rather than a track. Trees, overlays, and tweaks are all nearly free and — uniquely — **permanent** (`view.backgroundColor = .red` is not recomputed over). That is why FLEX, Reveal, Lookin, and Peek are good and old. But source locations are just as impossible: a swizzled `init(frame:)` **cannot** capture `#file`/`#line`, because default-argument literals are evaluated at the original call site and baked into the caller. Build-time instrumentation is the only answer, at which point it is the same macro pipeline as SwiftUI against an easier runtime. Fold it in as a bonus if the SwiftUI track ships; do not schedule it.

---

## 9. Ordered work breakdown

| # | Work | Days | Depends on |
|---|---|---|---|
| **W0** | Contracts + `InspectSession` + adapter seam + pane shell | **3-4** | — |
| **W1** | Flutter read-only inspector (VM service, tree, source, selection, property-string parser) | **4-6** | W0 |
| **W2** | Dart write-back sidecar + splice + verify + `workspace.changed` | **4-5** | W1 |
| **W3** | `realm_tweaks` pub package + drag loop | **3-4** | W1 |
| **W4** | Inspector panel UI (Figma-style: swatches, drag-scrub numbers, 4-up insets, refusal rows) | **5-7** | W1 (parallel with W2/W3) |
| **W5** | Compose read-only (`ui-tooling-data`, flag flip, `makeTree`, hit test, socket + `adb reverse`) | **5-7** | W0, W4 |
| **W6** | Compose `Modifier.tweakable` + Kotlin write-back (tree-sitter + Java sidecar) | **5-7** | W5 |
| **W7** | SwiftUI `#realm` macro, manifest, runtime store, overlay | **10-15** | W4 |
| **W8** | Swift write-back (tree-sitter-swift WASM) | **3-4** | W7 |
| **W9** | Simulator pane (idb gRPC + WebCodecs; scrcpy via Tango) | **8-12** | independent |

**First shippable slice: W0 + W1 + W2 + W4 ≈ 16-22 days** — tap a widget in a running Flutter app, see a real inspector, drag a value, accept, watch it land in the diff pane. Everything after that is a second and third platform against a proven shape.

Order rationale, stated so it survives contact with enthusiasm: **W7 is last not because SwiftUI matters least but because it is the only track whose cost is dominated by an unsolved problem rather than plumbing.** Doing it first would spend six weeks discovering the macro location arithmetic before we know whether the inspector panel is any good.

---

## 10. Risks and unknowns

**Named, load-bearing unknowns — resolve before committing the dependent work:**

1. **idb `video_stream` end-to-end latency (W9).** No published number and we did not install it. Structurally it is capture → VideoToolbox → UDS → WebCodecs with no network hop, so tens of milliseconds is plausible. **Spike it in a day before scheduling W9.** Fallback that works this week: Appium's WDA MJPEG server on port 9100 in an `<img>` — `multipart/x-mixed-replace` renders natively in Chromium — at the cost of an XCTest runner build and a 10 fps default.
2. **Flutter property-string parser coverage.** We know `Color`, `EdgeInsets`, `TextStyle` and enums arrive as `description` strings. We do not know the long tail. Sample 20 real widgets before finalising the W1 estimate.
3. **SwiftUI macro location arithmetic at scale.** Verified working on a synthetic file with a calibrated constant offset. Unverified on nested `ViewBuilder` closures, `if`/`switch` branches, and `ForEach` bodies. **This is the single highest-variance item in the plan.**
4. **`__designTime*` and App Store review.** Undocumented, double-underscored, but shipped in a `-library-level api` module. Unverified whether it triggers rejection in practice — which is exactly why it is an optional interop path and not the mechanism.

**Standing risks:**

- **Version churn, in three directions at once.** Flutter's `_Location` is being replaced by `dart:developer.CreationLocation` on master (`'name': ?name` omits the key when null; `CreationLocation` emits `'name': null` unconditionally — handle both). Compose's `@FunctionKeyMeta` retention is moving from `RUNTIME` to `BINARY` for 1.11+. `ui-tooling`'s `Inspectable`/`CompositionDataRecord` are now `internal`. tree-sitter-kotlin cannot parse Kotlin 2.4's stable context parameters. **Pin ranges, test against betas, and expect one breakage per platform per quarter.**
- **Every npm parser artifact is stale relative to its own repo** — tree-sitter-swift by 14 months, tree-sitter-kotlin by 2 years, tree-sitter-dart by 3.5 years. We ship WASM from GitHub release assets, not npm tarballs, and we own the upgrade chore.
- **Debug-only, everywhere.** Flutter's whole inspector surface is `assert`-gated; Compose's source info is R8-stripped; SwiftUI's instrumentation is `#if DEBUG`. Every pane state must detect and explain, never show an empty tree.
- **The opt-in cliff is the product risk, not the technical one.** Flutter needs a pub package for the drag loop, Compose needs `Modifier.tweakable` per call site, SwiftUI needs `#realm` per view. A user who installs nothing gets a *read-only* inspector on Flutter, a read-only inspector on Compose, and **nothing at all** on SwiftUI. If the product promise is "drag a padding and see it live," the onboarding must make the opt-in the first thing that happens, and the SwiftUI pane must be honest from the first empty state rather than the first support ticket.
- **`idb` links Apple private frameworks** — it will break on Xcode releases (iOS 26 changed the SimulatorHID wire format; Xcode 27 moved `SimulatorKit.framework`), it is undistributable via the Mac App Store, and it requires a full Xcode 26+ install. All acceptable for this audience, and decisively better than reimplementing the IOSurface path ourselves.

## Out of scope

Physical devices (mDNS + Local Network grants on iOS; broken on Simulator since macOS 15.4). React Native (§8). Web (Plan 17). Structural edits — adding, removing, or reparenting views; this plan edits **values at existing literal call sites** and nothing else. Multi-window and multi-display capture. Editing files outside the environment's checkout. Any write that is not a single literal token in a single non-shared source site.
