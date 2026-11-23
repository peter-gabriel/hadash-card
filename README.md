# Omnium Home 3D

A Home Assistant Lovelace card that shows your home in **3D**, made for a tablet on the wall. Rotate and zoom with your fingers, tap a light to switch it, and see the real sky and weather behind the house.

![Omnium Home 3D: a two-floor house in 3D with lit rooms, the sky, the weather and the now-playing widget](https://raw.githubusercontent.com/peter-gabriel/omnium-home-3d/main/docs/screenshot.png)

*Screenshots use a fictional house, devices and songs.*

- **Touch:** one finger rotates, pinch zooms, two fingers pan.
- **Devices on the plan:** tap to toggle a light, switch, fan, cover or TV. Hold to open Home Assistant's more-info dialog.
- **Rooms:** tap a room, or pick it from the **Rooms** button, and the camera flies to it and shows names and states. Tap again to go back to the overview.
- **Real light:** each light that is on lights its room's floor with its real color and brightness. The light is clipped to the room, so it never crosses a wall. Motion turns the room floor orange.
- **Several floors:** a floor picker on the right shows all floors stacked, or one floor with the others faded out.
- **Sky and weather:** the background follows the time of day from `sun.sun` (sunrise, day, golden hour, sunset, starry night) and the weather from a `weather.*` entity: clouds, rain, heavy rain, lightning, snow and fog. The outside temperature and condition are shown next to the clock.
- **Sun and shadows:** sunlight and shadows follow the real sun position. Cloudy weather softens them.
- **Actions:** the ⚡ button opens your scenes and scripts. Those that touch the selected room come first. Pin the ones you use most to the top of the screen.
- **Music:** a Spotify panel with search, library and speaker picker, plus a now-playing widget (see [Music](#music)).
- **Floor plan editor:** draw rooms, doors, stairs and devices on the tablet itself, over a photo of your floor plan.
- **Area sync:** link each room to a Home Assistant area. When you save, the card can create the missing areas and floors and move each device to its room's area.
- **Idle mode:** after a while without touches it goes back to the overview and slowly rotates.
- **Battery friendly:** the scene is only redrawn when something changes.
- **Localized:** Brazilian Portuguese, Spanish and English, following your Home Assistant language. Anything else falls back to English. The example house is translated too.

![The actions panel with the routines of the selected room](https://raw.githubusercontent.com/peter-gabriel/omnium-home-3d/main/docs/actions.png)

## Installation

The card is not in the default store yet, so you add it by its GitHub link. Updates then arrive with each new release.

### Marketplace (newer Home Assistant versions)

1. Open **Marketplace** in the sidebar and click **Add from link** (top right).
2. Paste `https://github.com/peter-gabriel/omnium-home-3d` and click **Add**.
3. Search for **Omnium Home 3D**, open it and click **Install**.
4. Reload the browser when asked.

The Marketplace adds the dashboard resource for you.

### HACS

1. In HACS → ⋮ → **Custom repositories**, add `https://github.com/peter-gabriel/omnium-home-3d` with the type **Dashboard**.
2. Search for **Omnium Home 3D**, download it, and reload the browser.

HACS adds the dashboard resource for you.

### Manual

1. Download `omnium-home-3d.js` from the [latest release](https://github.com/peter-gabriel/omnium-home-3d/releases/latest).
2. Copy it to `/config/www/`.
3. Add it under **Settings → Dashboards → ⋮ → Resources** as `/local/omnium-home-3d.js`, with the type *JavaScript module*.

If you switch from a manual install to the Marketplace or HACS, delete the old `/local/omnium-home-3d.js` resource. Otherwise the card is loaded twice.

### Wall tablet tips

Put the card alone in a dashboard view of the **Panel** type and set `height: 100%`. A kiosk browser (such as Fully Kiosk) keeps the screen on and hides the browser bars.

## Getting started

Add the card with no options and it shows an example two-floor house:

```yaml
type: custom:omnium-home-3d
height: 100%
```

Then tap the **pencil** button to open the floor plan editor and draw your own home. **Save** writes the plan straight into the dashboard.

## Floor plan editor

The pencil button opens the editor. By default it is only shown to administrators; `editor: false` hides it and `editor: true` shows it to everyone.

![The floor plan editor with a room selected](https://raw.githubusercontent.com/peter-gabriel/omnium-home-3d/main/docs/editor.png)

1. **Background plan:** pick a photo or screenshot of your floor plan. In Home Assistant the image is stored in Home Assistant itself, so it does not bloat the dashboard. Then use **Calibrate scale**: tap both ends of a known length and enter it in meters.
2. **Room:** drag a rectangle, or use **Free outline** and tap each corner for L-shaped rooms. A selected room can be moved. White corners change its shape, orange dots add corners, and a dragged corner snaps to the neighbouring room's corner.
3. **Home Assistant area:** link each room to an area. The room then uses the area's name and follows it when renamed, and the area's temperature, humidity and motion sensors are picked up. **+ New area…** creates the area in Home Assistant.
4. **Door:** tap a wall. The opening appears in both rooms that share the wall. Drag it to move it and set its width in the side panel.
5. **Stairs:** drag from the bottom to the top. **+ Floor** adds a floor, and the floor below is drawn dashed to help you line things up.
6. **Device:** pick it from the list and tap the plan. With an area set, **Add devices from…** places all of the area's devices at once.
   - **Switch that powers a plain bulb** (relay, smart wall switch): tick **Lights a bulb** when placing it. It is then drawn and lit as a light, and tapping it toggles the switch. Entities like `switch.*_l1` and names with "light", "lamp", "led" or "spot" are treated as lights by default. If one switch powers several spots, use **+ Another light point for this switch**.
7. **Sync with Home Assistant:** when you **Save** and the plan differs from Home Assistant, the card lists what would change, with a checkbox per item:
   - create areas for rooms that have none, or link to an existing area with the same name;
   - create the floors and put each area on its floor;
   - put each device in its room's area. This is done per entity, so the keys of one wall switch can sit in different rooms.

   Nothing is ever deleted or renamed in Home Assistant. **Save without touching HA** saves only the plan.
8. **View in 3D** previews without saving. If the card cannot write the dashboard, it shows the YAML to paste instead.

Use the mouse wheel or two fingers to zoom. Ctrl+Z undoes, Delete removes, Esc cancels.

## Configuration

The editor writes all of this for you. Coordinates are in **meters** on a plan seen from above: `x` to the right, `y` down.

```yaml
type: custom:omnium-home-3d
height: 100%                 # default 600px; use 100% in a panel view
wall_height: 1.0             # low walls look like a cut-away dollhouse
idle_seconds: 90             # back to the overview after this many seconds without touches
floors:
  - name: Ground floor
    stairs:
      - { from: [8.2, 7.8], to: [8.2, 5.4], width: 1.0 }   # goes up from this floor to the next
    rooms:
      - area: living_room                    # HA area id: name and sensors come from it
        rect: [0, 0, 6, 4.5]                 # x, y, width, depth
        openings:
          - { edge: 2, at: 1.0, width: 1.2 } # edge: 0 top, 1 right, 2 bottom, 3 left
        devices:
          - { entity: light.living_room_ceiling, pos: [3, 2.2] }
          - { entity: switch.living_room_l1, pos: [0.6, 3.9], light: true }
          - media_player.living_room_tv      # no pos: placed automatically
      - name: Kitchen
        polygon: [[6, 0], [9.5, 0], [9.5, 3], [6, 3]]
        temperature: sensor.kitchen_temperature
        motion: binary_sensor.kitchen_motion
  - name: Upper floor
    rooms:
      - { name: Bedroom, rect: [0, 0, 4.5, 4] }
```

A single-floor home can use `rooms:` at the top level instead of `floors:`.

| Option | Default | Description |
| --- | --- | --- |
| `height` | `600px` | Card height. Use `100%` in a panel view. |
| `floors` / `rooms` | example house | The plan. Without either, an example two-floor house is shown. |
| `floor_height` | `2.9` | Floor-to-floor height (m) used to stack floors; or `elevation` per floor. |
| `default_floor` | `all` | Floor shown on open and when idle: `all`, or `0`, `1`… |
| `wall_height` | `1.0` | Wall height (m). Per room with `wall_height`. |
| `wall_thickness` | `0.12` | Wall thickness (m). |
| `idle_seconds` | `90` | Seconds without touches before going back to the overview. |
| `idle_rotate` | `true` | Rotate slowly while idle. |
| `show_coords` | `false` | Ruler button: tap the floor to see and copy `[x, y]`. |
| `editor` | admins only | `true` / `false` to always show or hide the editor button. |
| `quality` | `high` | `low` turns off shadows and environment lighting for slower tablets. |
| `north` | `0` | Degrees the plan is rotated from north, so the sun comes from the right side. |
| `weather_entity` | first `weather.*` | Weather shown in the sky and next to the clock. |
| `sun_entity` | `sun.sun` | Sun used for the time of day and the shadows. |
| `sky` | `true` | `false` for a plain background. |
| `weather_effects` | `true` | `false` turns off animated clouds, rain and snow. They also stop with the system's "reduce motion". |
| `actions` | all | Scripts and scenes listed in the ⚡ panel. |
| `actions_pinned` | — | Scripts, scenes or automations shown as shortcuts at the top. |
| `music` | — | Music panel, see below. |

## Actions

The ⚡ button opens a panel on the right with your **scenes and scripts**. The house stays visible beside it.

- **In this room:** with a room selected, the scripts and scenes that touch its devices or its area are listed first. The card finds this out by reading each script's configuration.
- Tap ▶ to run one. A notice confirms it and the devices it touches pulse on the plan.
- Automations are not listed in the panel. To show one, pin it.

```yaml
actions:                         # optional: limit the panel to these
  - script.movie_mode
  - scene.dinner
actions_pinned:                  # shortcuts at the top of the screen
  - script.bathroom_lights_off
  - automation.goodnight         # a pinned automation runs its actions right away
```

## Music

```yaml
music:
  entity: media_player.spotifyplus_yourname
  now_playing: true              # now-playing widget in the corner
  card:                          # optional: a full third-party card behind a "Full Spotify" button
    type: custom:spotifyplus-card
    entity: media_player.spotifyplus_yourname
```

- The ♪ button opens the music panel over the house: now playing with progress and volume, **Search**, **Recent**, **Liked**, **Playlists** and **Speakers**.
- Search and the library tabs need the [SpotifyPlus](https://github.com/thlucas1/homeassistantcomponent_spotifyplus) integration. With any other `media_player`, the panel shows the player and the speakers.
- **Speakers on the plan:** add a device with `speaker: <source name>` to place a speaker. Tapping it moves the music there; tapping the playing speaker pauses or resumes it, and it glows green while playing.

The music panel is the [Omnium Music](https://github.com/peter-gabriel/omnium-music), bundled in Omnium Home 3D. You can also install it on its own to use in any dashboard.

## Development

```bash
npm install
npm test          # sky, geometry, area sync, action and i18n tests
npm run build     # outputs dist/omnium-home-3d.js
npm run dev       # demo with a fake Home Assistant on http://localhost:5181 (?lang=en, pt-BR or es)
```

### Quick dev loop

```bash
npm run ha
```

This rebuilds on every change and serves the file at `http://<your-machine-ip>:5182/omnium-home-3d.js`. Add that URL as a resource on a test dashboard, then refresh Home Assistant after each change.

### Adding a language

UI strings live in [`src/i18n.ts`](src/i18n.ts). Add a dictionary of type `Strings` and map its language prefix in `strings()`. The test suite checks that every language has every key.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branching model (git flow), the pull request flow and how releases are made.

## License

[MIT](LICENSE)
