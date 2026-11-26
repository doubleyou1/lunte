# Lunte

Lokales Arcade-Spiel für 2 bis 8 Personen. Der Laptop zeigt die Arena am Beamer,
die Handys sind Gamepads im Browser. Es braucht weder App noch Internet.

## Setup (einmal, mit Internet)

Voraussetzung ist Node.js ab Version 18.

```bash
npm install
```

Danach läuft alles ohne Netz. Grafik und Sound werden im Browser erzeugt.

## Start

```bash
npm start
```

1. Am Laptop `http://localhost:3000/beamer` öffnen und mit `F11` auf Vollbild stellen.
2. Die Handys scannen den QR-Code und geben einen Namen ein.
3. Am Laptop mit **Leertaste** oder Klick starten. `Esc` führt zurück zur Lobby und
   setzt den Punktestand zurück.

Nur der Browser auf dem Laptop selbst darf Runden starten. Die Beamer-Seite muss
deshalb über `localhost` geöffnet werden.

## Netzwerk

Laptop und Handys müssen im selben Netz sein. Unter Linux mit NetworkManager lässt
sich ein vorhandener Hotspot so starten und mit Zugangsdaten anzeigen:

```bash
nmcli connection up Hotspot
nmcli device wifi show-password
```

**Router vor Ort:** Alle verbinden sich mit demselben WLAN. Ein Internetanschluss
ist nicht nötig. Gäste-WLANs sperren oft den Verkehr zwischen Geräten
(„Client Isolation“), dann funktioniert der QR-Code nicht.

**Laptop-Hotspot:** Hotspot aktivieren und die Handys verbinden. Der QR-Code
aktualisiert sich innerhalb weniger Sekunden. Manche Handys wechseln ohne Internet
zurück ins Mobilnetz: Mobile Daten ausschalten oder „WLAN beibehalten“ bestätigen.

**Firewall:** Port 3000 (TCP) muss eingehend erlaubt sein, unter Ubuntu etwa mit
`sudo ufw allow 3000/tcp`. Unter Windows beim ersten Start den Zugriff für private
Netzwerke erlauben.

**Falsche Adresse im QR-Code** (zum Beispiel bei VPN oder mehreren Netzwerkkarten):

```bash
LAN_IP=192.168.1.20 npm start
```

Ein anderer Port geht mit `PORT=8080 npm start`.

## Regeln

- Links: Pfeiltasten, der Daumen darf zwischen den Richtungen gleiten. Rechts: Bombe legen.
- Bomben zünden nach 3 Sekunden, explodieren als Kreuz und lösen andere Bomben aus.
- Jede Figur hat 2 Leben und ist nach einem Treffer kurz geschützt.
- Power-ups: mehr Bomben (blau), größere Weite (orange), mehr Tempo (grün).
- Nach 2 Minuten schließt sich die Arena von außen. Rot blinkende Felder sind die nächsten.
- Wer zuletzt übrig ist, gewinnt die Runde.
- Einen plötzlichen Verbindungsabbruch erkennt der Server nach rund 20 Sekunden. Dann
  bleibt die Figur stehen und scheidet nach 10 Sekunden aus. Bis dahin führt Neuladen
  oder Reconnect zurück in dieselbe Figur.

Alle Spielwerte stehen in `server/config.js`.

## Testen ohne Handys

```bash
npm run dev -- 8           # 8 Bots, Start am Beamer
npm run dev -- 8 --start   # Runden starten zusätzlich automatisch
npm test                   # Tests der Spiellogik
```

`npm run dev` startet den Server mit, falls er noch nicht läuft. Die Bots brauchen
die Dev-Abhängigkeiten, also ein normales `npm install`.

## Checkliste für den Abend

**Vorher zu Hause**

- [ ] `npm install` ausgeführt, `npm test` ist grün
- [ ] Mit getrenntem Internet `npm start` und `npm run dev -- 8 --start` geprüft
- [ ] Mindestens ein iPhone und ein Android-Handy probeweise verbunden

**Vor Ort**

- [ ] Netzteil am Laptop, Energiesparen und Bildschirmsperre aus
- [ ] Beamer angeschlossen, Bild gespiegelt oder Browser auf den Beamer gezogen
- [ ] WLAN oder Hotspot läuft, Laptop ist verbunden
- [ ] `npm start`, Beamer-Seite über `localhost` öffnen, `F11`
- [ ] Ton prüfen: Sound startet nach dem ersten Klick oder Tastendruck am Laptop
- [ ] Erstes Handy scannt den QR-Code und erscheint in der Lobby

**Für alle Mitspielenden**

- [ ] Automatische Display-Sperre möglichst verlängern
- [ ] Mobile Daten aus, falls das Handy das WLAN verlässt
- [ ] Rotationssperre aus, Handy quer halten

**Wenn etwas hakt**

- QR-Code öffnet nichts: gleiches WLAN? Firewall? Adresse unter dem QR-Code prüfen.
- Handy fliegt raus: Seite neu laden, die Figur kommt zurück.
- Spieler weg, Platz belegt: Der Platz wird nach 60 Sekunden außerhalb einer Runde frei.

## Entstehung und Lizenz

Das Spiel wurde mit Claude Code erstellt. Es steht unter der MIT-Lizenz, siehe `LICENSE`.
