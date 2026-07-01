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
        # "Nikolas Vlassopoulos",  # example — replace with real execs
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
