# Laser Flow

A browser mini puzzle game where you clear boxes in the laser path and guide the beam to the target.

## About The Game
Laser Flow is a quick, tap-to-play path puzzle with:
- turn markers (yellow diamonds)
- score and win streak system
- high score tracking
- sound effects for correct taps, game over, and win
- splash screen intro

## How To Play
1. Start the game and read the rules shown at the top.
2. Follow the laser path.
3. Tap only the next correct path box to clear it.
4. Reach the green target to win the round.

## Game Rules
- Red circle = start point.
- Green circle = target point.
- Yellow diamonds = path turns/corners.
- You must tap the next box in order.
- Tapping a trap box or wrong-order box ends the round.

## Scoring
- +10 points for each correct box cleared.
- Win bonus is awarded on victory.
- Consecutive wins increase the win bonus.
- High score updates when your total score beats the previous high score on win.
- Score data is persisted in `localStorage`.

## UI Behavior
- Rules are shown at round start and hidden after the first correct clear.
- Restart button is shown on game over.
- New Game button is shown on win.
- In landscape mobile layout, panel and board are shown side by side.

## Technologies Used
- HTML5
- CSS3 (responsive layout with media queries)
- JavaScript (ES Modules)
- [Three.js](https://threejs.org/) for 3D rendering
- Web Audio API for sound effects
- Browser `localStorage` for score persistence

## Run Locally
Because the game uses ES modules and JSON fetch, run it from a local web server.

Example with Python:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Project Files
- `index.html` - app structure and UI container
- `style.css` - game and responsive UI styling
- `main.js` - game logic, rendering, scoring, sounds
- `level1.json` - level configuration

## License
This project is **All Rights Reserved**.
See the full terms in the [LICENSE](./LICENSE) file.

## Version
- Current version label shown in splash: **1.0**
