# Desktop backends — what runs, where, and what proved it

This toolkit drives one lane: the desktop — the real screen and the real applications on it. This
file is the honest scoreboard, and `rpa doctor --profile desktop` prints the same picture for the
machine you are on. A backend counts as available only when it **proved** itself on that host: the
probe loads the module in a child process and asks it one real question.

| backend | Windows | Linux | macOS | what it gives |
|---|---|---|---|---|
| **nut.js** (default) | ✅ prebuilt | ⚠️ X11 works; a Wayland session answered `screen.width()` and then died on capture with `X_GetImage`/`BadMatch` | ✅ (Accessibility + Screen Recording granted) | mouse, keyboard, capture, clipboard, windows, image search |
| **robot.js** (fallback) | ✅ prebuilt | ✅ prebuilt | ✅ prebuilt | mouse, keyboard, capture (raw pixels, written by this repo's own PNG encoder); no clipboard, no image search |
| **OS tools** | ✅ PowerShell + .NET (`System.Windows.Forms`, `System.Drawing`) | ✅ xdotool + a capture tool that really grabs the screen | ⚠️ click `{x,y}`, type, clipboard, capture — System Events cannot move the pointer or scroll | no addon and no build step; the only backend a CI container can prove |

`rpa robot` reports the *proved* set to the orchestrator, so a machine with no display is never
handed a desktop flow. A robot declares the desktop family by default; the probe decides whether it
answers.

## Why the probe runs in a child process

A native addon that reaches into X11 (or the Windows input APIs) can abort the **whole process**
before any JavaScript sees the failure — on this project's own host, libnut's capture did exactly
that on a Wayland session, with Xlib's default error handler calling `exit`. So a probe that ran
in-process would take the robot down instead of reporting a missing capability. Each probe therefore
spawns `node` once, loads the module, performs the call the lane depends on (a capture, not just a
screen-size query — the size query passed where the capture died) and reads the exit code plus the
first interesting stderr line. The chosen backend then runs in-process for real work.

## Capabilities, declared and proved

| capability | what a step needs it for |
|---|---|
| `move` | `desktop.move`, `desktop.drag`, the pointer half of everything else |
| `click` | `desktop.click`, `doubleClick`, `rightClick`, `clickImage`, `ai-vision.decide` with a click |
| `scroll` | `desktop.scroll` |
| `keyboard` | `desktop.type`, `desktop.pressKey`, `ai-vision.decide` with typing |
| `clipboard` | `desktop.clipboardCopy` |
| `capture` | `desktop.screenshot`, `ocr.recognize`, `ai-vision.decide` |
| `image` | `desktop.waitForImage`, `desktop.clickImage`, image targets |

A step asks for the capability it needs and is refused **by name** when the chosen backend cannot
serve it (`desktop.clickImage needs the "image" capability and the os backend does not provide it
on darwin — …`). Nothing half-runs.

Capture is proved twice over on Linux: the tool must be installed **and** must really write a file
for a throwaway target (`import` is installed here and refuses the screen; spectacle and ffmpeg's
x11grab work). The first candidate that writes wins, and the reason the others did not is in the
backend's own detail line.

## Targeting on the desktop

A target is one of four things, tried in order of confidence, plus a point for the trivial case:

```jsonc
{
  "type": "desktop", "action": "click",
  "target": {
    // 1. accessibility properties — every listed one must match (Windows UI Automation)
    "uia": { "automationId": "saveBtn", "name": "Save", "controlType": "Button" },
    // 2. the same properties, scored instead of matched ('exact' is still a hard gate)
    "fuzzy": { "properties": { "name": "Save" }, "threshold": 0.8 },
    // 3. a template found on screen
    "image": { "path": "assets/save.png", "threshold": 0.9 },
    // 4. a second element that disambiguates by geometry
    "anchor": { "target": { "fuzzy": { "properties": { "name": "File" } } }, "relation": "right" },
    "idx": 1
  }
}
```

Property candidates come from the accessibility API where the host has one: on Windows the engine
dumps the focused window's controls once per lookup and scores them in JavaScript, which is what
makes a fuzzy pass, an anchor filter and a *healed* suggestion possible at all. Where there is no
such API (Linux, macOS today) the property pass refuses with the sentence that says so, and image,
OCR and vision targeting are the answer — the same honest refusal the rest of the toolkit follows.

Healing keeps its two passes: `relaxed-fuzzy` re-scores the properties with the 'exact' gates
dropped, `resemblance` retries the image at a lower threshold. `recommend` (the default) fails the
step but puts the candidate in the log, the error and the run's `heals`; `auto` continues on it;
`off` is the plain failure.

## Transport notes per platform

- **Windows**: `desktop.uia` drives the accessibility API through PowerShell (no addon), and the OS
  backend drives input and capture through .NET. Both are asserted in this repo's test suite from
  any host, because a PowerShell script is a string.
- **Linux/X11**: xdotool for input, and a capture tool proved at probe time. Under Wayland only
  XWayland clients can be driven, and a native-addon capture may abort the process — the seam
  reports that instead of crashing, and the OS backend (ffmpeg/spectacle) is what answers.
- **macOS**: the OS backend clicks by coordinate through System Events and captures with
  `screencapture`; moving the pointer and scrolling are declared **unavailable**, because System
  Events cannot do them. nut.js is the backend that covers those, given the Accessibility and
  Screen Recording grants.

## What is not here yet

- Wayland-native input (`ydotool` needs a daemon; libnut and xdotool both speak X11 only).
- A macOS accessibility dump (System Events can act on a window, not enumerate its controls) and the
  Linux equivalent over AT-SPI — the two API-shaped gaps behind element targeting outside Windows.
- A dependency-free image matcher: the current default is nut.js's Jimp-based search, and a native
  accelerated matcher is one of the things the paid tier of that project sells. A typed-array
  template match over a captured screen is the honest open replacement.
- Extra backends worth adding where they are stronger: `keysender` (Windows hotkeys and window
  handles) and `active-win` (window enumeration on all three platforms).
