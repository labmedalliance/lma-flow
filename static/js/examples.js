// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Janne Cadamuro / LabMed Alliance Inc. — see LICENSE and NOTICE
/* Starter templates, one per diagram type. Own content, written for this app. */
window.FLOW_EXAMPLES = [
  {
    name: "Flussdiagramm",
    code: `flowchart TD
    A[Probe eingegangen] --> B{Barcode lesbar?}
    B -- ja --> C[Zentrifugieren]
    B -- nein --> D[Manuell erfassen]
    D --> C
    C --> E{Hämolyse?}
    E -- nein --> F[Analyse]
    E -- ja --> G[Neuabnahme anfordern]
    F --> H[(Befund im LIS)]`,
  },
  {
    name: "Sequenzdiagramm",
    code: `sequenceDiagram
    participant S as Station
    participant L as Labor
    participant LIS
    S->>L: Probe + Anforderung
    L->>LIS: Auftrag anlegen
    LIS-->>L: Auftragsnummer
    L->>L: Messung
    L->>LIS: Ergebnis
    LIS-->>S: Befund freigegeben
    Note over L,LIS: Kritischer Wert? Dann telefonisch melden`,
  },
  {
    name: "Klassendiagramm",
    code: `classDiagram
    class Probe {
        +String barcode
        +DateTime abnahme
        +zentrifugieren()
    }
    class Auftrag {
        +int nummer
        +List~Test~ tests
    }
    class Test {
        +String code
        +float ergebnis
    }
    Auftrag "1" --> "*" Probe
    Auftrag "1" --> "*" Test`,
  },
  {
    name: "Zustandsdiagramm",
    code: `stateDiagram-v2
    [*] --> Angefordert
    Angefordert --> Eingegangen: Probe da
    Eingegangen --> InMessung
    InMessung --> Validiert: plausibel
    InMessung --> Wiederholung: unplausibel
    Wiederholung --> InMessung
    Validiert --> [*]`,
  },
  {
    name: "ER-Diagramm",
    code: `erDiagram
    PATIENT ||--o{ AUFTRAG : hat
    AUFTRAG ||--|{ PROBE : umfasst
    PROBE ||--o{ ERGEBNIS : liefert
    PATIENT {
        string id
        date geburtsdatum
    }
    ERGEBNIS {
        string test
        float wert
        string einheit
    }`,
  },
  {
    name: "Gantt",
    code: `gantt
    title Einführung neuer Analysator
    dateFormat YYYY-MM-DD
    section Vorbereitung
    Ausschreibung        :a1, 2026-01-05, 30d
    Installation         :a2, after a1, 10d
    section Validierung
    Methodenvergleich    :b1, after a2, 20d
    Schulung             :b2, after a2, 5d
    section Betrieb
    Routinestart         :milestone, after b1, 0d`,
  },
  {
    name: "Tortendiagramm",
    code: `pie title Präanalytische Fehler
    "Hämolyse" : 52
    "Zu wenig Material" : 18
    "Falsches Röhrchen" : 13
    "Geronnen" : 11
    "Sonstiges" : 6`,
  },
  {
    name: "Mindmap",
    code: `mindmap
  root((Präanalytik))
    Patient
      Nüchternheit
      Medikamente
    Abnahme
      Stauzeit
      Reihenfolge
    Transport
      Temperatur
      Dauer`,
  },
  {
    name: "Zeitstrahl",
    code: `timeline
    title Projektverlauf
    2025 : Idee
         : Konzept
    2026 : Pilotphase
         : Rollout`,
  },
  {
    name: "Git-Graph",
    code: `gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit`,
  },
];
