# Mukwano-Rafiki

## Your friend between languages

Mukwano-Rafiki is a multilingual helper for East Africa. It translates between **Luganda, Swahili, and English**, and chats with people in the way they really speak, including mixed-language messages, slang, and informal phrasing. It gives general, personalized advice on everyday topics such as school, health basics, farming, and small business.

*Mukwano* means “friend” in Luganda, and *Rafiki* means “friend” in Swahili.

## Live Demo

**Try the app:** [https://mukwano-rafiki.ai.studio/]

**Demo video:** [https://youtu.be/Ms0jaj8_1kk]

> **Note:** The app may take a few seconds to wake up on the first visit.

## The Problem

Millions of people in East Africa speak Luganda and Swahili, but most apps and AI tools understand these languages poorly. This makes everyday life harder in clinics, markets, and schools.

## What It Does

- **Translator:** Translate between Luganda, Swahili, and English, with a context setting (General, Health, Market, or School), a confidence badge, and notes about ambiguity or respectful forms.
- **Chatbot:** Understand mixed-language messages and informal speech, reply in the user's language, and ask a short clarifying question when a message is unclear.
- **Personalized advice:** Adapt answers to the user's language, interests, and situation. The app provides general guidance only.
- **Test mode:** Native speakers rate each translation as **Correct**, **Understandable but unnatural**, or **Wrong**. The app calculates accuracy per language.
- **Feedback loop:** Users can report a bad translation and suggest a better one.

## Testing With Native Speakers

We do not just trust the AI. Native speakers rate the output in Test mode.

| Language pair | Phrases rated | Correct | Accuracy |
|---|---:|---:|---:|
| English to Luganda | [10] | [8] | [80]% |
| Luganda to English | [15] | [10] | [66]% |
| English to Swahili | [X] | [X] | [X]% |
| Swahili to English | [X] | [X] | [X]% |

## Built With

- Google Gemini API (via Google AI Studio)
- React
- Node.js
- Vite

## Getting Started

### Requirements

- Node.js (LTS version)
- A Gemini API key from Google AI Studio

### Run It Locally

Clone the repository:

```bash
git clone https://github.com/DISMAS179/mukwano-rafiki.git
cd mukwano-rafiki
```

Install dependencies:

```bash
npm install --legacy-peer-deps
```

Create your environment file from the example:

```bash
cp .env.example .env
```

On Windows, use:

```powershell
copy .env.example .env
```

Open `.env` and add your own values. Check [`.env.example`](./.env.example) for the exact variable names. Typical values include:

```env
GEMINI_API_KEY=your_key_here
PRIMARY_MODEL=your_gemini_model_id
APP_URL=http://localhost:3000
```

Start the app:

```bash
npm run dev
```

Open the local address shown in the terminal.

You can also run the project's checks:

```bash
npm run lint
npm run build
```

> **Never commit your `.env` file or share your API key.**

## Limitations

Luganda is a low-resource language, so translation quality can vary. Use the confidence badge and verify important text with a native speaker.

The chatbot gives general information only. It is not professional medical, legal, or financial advice.

## Roadmap

- Voice input
- Offline mode with small open models
- More languages, including Runyankole, Luo, and others
- Partnerships with clinics and schools for real-world testing

## Contributing

Contributions are welcome. You can help by:

- Submitting corrected translations or new test phrases
- Reporting bugs or unclear answers
- Adding new languages
- Improving the interface and documentation

To contribute, fork the repository, create a branch, make your changes, run the checks above, and open a pull request.

## Team

| Name | Role / contribution |
| [Eleni]      |[Documentation]    |
| [Dismas]     | [Project Leader]  |
| [Kieth]      | [Demo & Design]   |
| [Changkuoth] | [Swahili Tester ] |
| [Turuk]      | [Luganda Tester]  |

## License

[MIT]

## Acknowledgements

Thanks to the native speakers who tested the translations, and to Major League Hacking and Google for the tools and the event.
