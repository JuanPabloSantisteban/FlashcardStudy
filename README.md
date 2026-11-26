# Flashcards

A small self-graded flashcard site. Pick a category (School, IB preparation, General Concepts),
filter by course and topic, flip cards and mark each green (knew it) or red (didn't).
Math is written in LaTeX and rendered with KaTeX.

- Cards live in `cards/` as plain text files. **How to add cards: see [CARD_GUIDE.md](CARD_GUIDE.md).**
- No build step and no server: it runs on GitHub Pages as is.
- Green/red marks are saved in the browser and, once sync is on, in a private Gist on your GitHub account so phone and computer stay in step.

## Add cards in the app

Tap **+ Add**, pick the category, type course, topic, front and back (math preview included) and save. The card is committed to this repository, so it reaches every device after GitHub Pages republishes (about a minute; it shows on the device you used straight away).

To attach a picture (for example a handwritten proof), tap **Add image** below the Back box, or paste an image into the text box on a computer. Images are stored in `images/`; tap one on a card to see it full screen.

## Turn on sync and card saving (once per device)

1. Create a classic token at https://github.com/settings/tokens/new?scopes=gist,public_repo with only **gist** and **public_repo** ticked. Pick a long expiration or none.
2. In the app open **Progress → Sync between devices**, paste the token and press **Turn on sync**.
3. Do the same on your other device with the same token.

The token is stored only in that browser. It can write to your gists and public repositories. If it expires, the top bar shows "Sync error"; make a new token and paste it again.
For each card the most recent mark wins, so you can review on either device. Export / Import on the Progress page still works as a manual backup.

## Run locally

```
python3 -m http.server 8000
```
then open http://localhost:8000. (Opening `index.html` directly from disk won't load the cards.)

## Publish on GitHub Pages

Repository → Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.
The site appears at `https://<username>.github.io/<repo>/`. Changes to cards go live about a minute after each push.

## On your phone

Open the link and use "Add to Home Screen" (Safari share menu, or the Chrome menu) to get an app icon.

## Files

```
index.html            page shell
assets/app.js         the app (parsing decks, filters, review, marks)
assets/style.css      styles (light and dark mode)
assets/vendor/        KaTeX 0.16.9 and marked 12.0.2, bundled so no CDN is needed
cards/index.json      categories and the list of deck files
cards/**/*.md         the decks
CARD_GUIDE.md         instructions for Claude (or you) on writing cards
```
