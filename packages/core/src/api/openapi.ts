import { OUTPUT_FORMATS, SCRAPE_MODES } from "../scrape/types.ts";

const errorResponse = (description: string) =>
  ({
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
    description,
  }) as const;

/** The OpenAPI description of the HTTP API. Enum values come from the same constants the code uses. */
export const buildOpenApiDocument = () =>
  ({
    components: {
      schemas: {
        Error: {
          properties: {
            error: {
              properties: {
                code: { example: "invalid_request", type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
              type: "object",
            },
          },
          required: ["error"],
          type: "object",
        },
        Location: {
          description: "Where the scrape should appear to come from. Every field is optional.",
          properties: {
            city: { example: "Austin", type: "string" },
            country: { example: "US", type: "string" },
            state: { example: "TX", type: "string" },
          },
          type: "object",
        },
        ScrapeRequest: {
          properties: {
            format: { default: "html", enum: [...OUTPUT_FORMATS], type: "string" },
            location: { $ref: "#/components/schemas/Location" },
            mode: {
              default: "http",
              description: "http is a plain GET; headless and headful need a browser plugin.",
              enum: [...SCRAPE_MODES],
              type: "string",
            },
            url: { example: "https://example.com", format: "uri", type: "string" },
          },
          required: ["url"],
          type: "object",
        },
      },
    },
    info: {
      description: "Send a URL, get the page back in the format you ask for.",
      title: "Xrio API",
      version: "1.0.0",
    },
    openapi: "3.0.3",
    paths: {
      "/scrape": {
        post: {
          description: "Fetches the page and returns it rendered in the requested format.",
          requestBody: {
            content: {
              "application/json": {
                example: { format: "json", url: "https://example.com" },
                schema: { $ref: "#/components/schemas/ScrapeRequest" },
              },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: { type: "string" } },
                "application/xml": { schema: { type: "string" } },
                "text/csv": { schema: { type: "string" } },
                "text/html": { schema: { type: "string" } },
              },
              description: "The page, with the Content-Type matching the requested format.",
            },
            "400": errorResponse("The request body is not valid."),
            "500": errorResponse("Unexpected server error."),
            "501": errorResponse("The mode or format is not available."),
            "502": errorResponse("The target site could not be fetched."),
          },
          summary: "Scrape a URL",
        },
      },
    },
  }) as const;
