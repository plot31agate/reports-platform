"""Sportingtech client configuration.

Executive and competitor lists are best-guess starting points — edit these
to match reality when you have the actual names.
"""

SPORTINGTECH = {
    "slug": "sportingtech",
    "display_name": "Sportingtech",
    "brandline": "Winning Edge",
    "tagline": "Build. Expand. Grow.",

    # Brand palette from Sportingtech guidelines
    "colours": {
        "coral": "#FF4F40",
        "teal": "#00D8AE",
        "black": "#000000",
        "white": "#FFFFFF",
        "lime": "#B6EC2D",
        "blue": "#0069C4",
        "hero": "#FF4F40",       # dominant hero colour for reports
        "accent": "#00D8AE",     # positive-trend + accent
    },

    "font_stack": "'Aptos', 'Inter', system-ui, -apple-system, sans-serif",

    # Fill these in with real names when known
    "executives": [
        "Nana Totoe",
        "Emma Loveday",
        "Camilo Millon",
        "Tommy Molloy",
        "Michael Jack",
        "Anthony Murphy",
        "Tom Ustunel",
    ],

    "competitors": [
        "BetConstruct",
        "Altenar",
        "Soft2Bet",
        "EveryMatrix",
        "Kambi",
        "SBTech",
    ],

    "regions_of_interest": [
        "LATAM",
        "Brazil",
        "Colombia",
        "Peru",
        "Mexico",
        "Europe",
    ],

    # RSS/Atom feeds pulled by Auto-fetch on the workspace (Google Alerts
    # for the brand and each executive). Editable per client in the
    # workspace under "Mention feeds".
    "mention_feeds": [
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/16170668821117914581",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/4360640709969990399",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/1303721399638411999",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/12133739773753703727",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/4664133647478171063",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/18446529224811404312",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/9277082318107763866",
        "https://www.google.co.uk/alerts/feeds/07184293393273308205/13625659024980385575",
    ],

    # Passed to Claude for sentiment classification
    "sentiment_context": (
        "You are analysing media mentions of Sportingtech, a B2B iGaming "
        "platform vendor providing sportsbook and casino technology to "
        "operators, with strong presence in LATAM markets. "
        "Score sentiment from Sportingtech's commercial perspective:\n"
        "- Regulatory news is often NEUTRAL or POSITIVE even when phrased "
        "critically, as regulation opens new addressable markets.\n"
        "- New market entries, product launches, and executive hires are "
        "POSITIVE.\n"
        "- Competitor wins, competitor product launches in shared markets, "
        "and licence losses are NEGATIVE.\n"
        "- LATAM regulatory clarity (Brazil, Colombia, Peru) is strongly "
        "POSITIVE.\n"
        "- Generic industry commentary without directional signal is NEUTRAL."
    ),
}
