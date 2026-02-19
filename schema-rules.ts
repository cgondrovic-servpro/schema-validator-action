/**
 * Schema.org validation rules: required/recommended properties and property-type expectations.
 * Vocabulary (known types/properties) is from the official Schema.org context; see schema-vocabulary.generated.ts.
 * Required, recommended, and propertyTypes are curated from Schema.org + Google guidelines—validator.schema.org
 * does not publish these rules, so they cannot be auto-synced.
 */

import { knownTypes, knownProperties } from "./schema-vocabulary.generated.js";

export interface TypeRule {
  required: string[];
  recommended: string[];
  /** property name -> allowed @type values (without schema.org prefix) */
  propertyTypes: Record<string, string[]>;
}

export const schemaRules: Record<string, TypeRule> = {
  Product: {
    required: ["name", "image", "offers"],
    recommended: ["description", "sku", "brand", "aggregateRating"],
    propertyTypes: {
      offers: ["Offer", "AggregateOffer"],
      brand: ["Brand", "Organization"],
      aggregateRating: ["AggregateRating"],
      review: ["Review"],
    },
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs"],
    propertyTypes: {
      address: ["PostalAddress"],
      logo: ["ImageObject"],
    },
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["url", "telephone", "openingHours", "image"],
    propertyTypes: {
      address: ["PostalAddress"],
      geo: ["GeoCoordinates"],
      image: ["ImageObject"],
    },
  },
  Article: {
    required: ["headline", "image"],
    recommended: ["datePublished", "dateModified", "author", "publisher"],
    propertyTypes: {
      author: ["Person", "Organization"],
      publisher: ["Organization"],
      image: ["ImageObject"],
    },
  },
  WebPage: {
    required: ["name"],
    recommended: ["description", "url", "breadcrumb"],
    propertyTypes: {
      breadcrumb: ["BreadcrumbList"],
    },
  },
  Person: {
    required: ["name"],
    recommended: ["url", "image"],
    propertyTypes: {},
  },
  Offer: {
    required: ["price", "priceCurrency"],
    recommended: ["availability", "url", "seller"],
    propertyTypes: {},
  },
  AggregateOffer: {
    required: ["lowPrice", "priceCurrency"],
    recommended: ["offerCount", "highPrice", "availability"],
    propertyTypes: {},
  },
  PostalAddress: {
    required: [],
    recommended: [
      "streetAddress",
      "addressLocality",
      "addressRegion",
      "postalCode",
      "addressCountry",
    ],
    propertyTypes: {},
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
    propertyTypes: {
      itemListElement: ["ListItem"],
    },
  },
};

/** Re-export for callers that need the vocabulary sets. From schema-vocabulary.generated.ts (Schema.org official context). */
export { knownTypes, knownProperties };

const getTypes = (block: Record<string, unknown>): string[] => {
  const t = block["@type"];
  if (typeof t === "string") return [t.replace(/^schema:/, "")];
  if (Array.isArray(t))
    return t.map((x) =>
      typeof x === "string" ? x.replace(/^schema:/, "") : "",
    );
  return [];
};

/** Check if an object is a JSON-LD reference (only has @id, no @type). References point to other nodes and shouldn't be validated inline. */
const isReference = (obj: Record<string, unknown>): boolean => {
  const keys = Object.keys(obj);
  return keys.includes("@id") && !keys.includes("@type");
};

export interface ValidationMessage {
  kind: "error" | "warning";
  message: string;
}

/** When false (default), only report errors (missing required, wrong types). When true, also warn on unknown types/properties and missing recommended. */
export interface ValidateOptions {
  strict?: boolean;
}

export const validateBlock = (
  block: Record<string, unknown>,
  options?: ValidateOptions,
  path: string = "",
): ValidationMessage[] => {
  const strict = options?.strict === true;
  const messages: ValidationMessage[] = [];
  const prefix = path ? `${path} → ` : "";
  const types = getTypes(block).filter(Boolean);
  if (types.length === 0) {
    messages.push({ kind: "error", message: `${prefix}Missing @type` });
    return messages;
  }
  const primaryType = types[0];
  const rule = schemaRules[primaryType];
  if (!rule) {
    if (strict && !knownTypes.has(primaryType)) {
      messages.push({
        kind: "warning",
        message: `${prefix}Unknown @type: ${primaryType}`,
      });
    }
    return messages;
  }
  for (const prop of rule.required) {
    const val = block[prop];
    if (
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "")
    ) {
      messages.push({
        kind: "error",
        message: `${prefix}Missing required property: ${prop} (${primaryType})`,
      });
    }
  }
  if (strict) {
    for (const prop of rule.recommended) {
      const val = block[prop];
      if (val === undefined || val === null) {
        messages.push({
          kind: "warning",
          message: `${prefix}Missing recommended property: ${prop} (${primaryType})`,
        });
      }
    }
  }
  for (const [prop, allowedTypes] of Object.entries(rule.propertyTypes)) {
    const rawNested = block[prop];
    if (rawNested === undefined || rawNested === null) continue;

    if (Array.isArray(rawNested)) {
      rawNested.forEach((item, idx) => {
        if (typeof item === "object" && item !== null) {
          const itemObj = item as Record<string, unknown>;
          if (isReference(itemObj)) return;
          const nestedType = getTypes(itemObj)[0];
          const nestedPath = path
            ? `${path}.${prop}[${idx}]`
            : `${prop}[${idx}]`;
          if (
            nestedType &&
            allowedTypes.length &&
            !allowedTypes.includes(nestedType)
          ) {
            messages.push({
              kind: "error",
              message: `${prefix}Property "${prop}[${idx}]" expected @type one of [${allowedTypes.join(", ")}], got ${nestedType} (${primaryType})`,
            });
          }
          messages.push(...validateBlock(itemObj, options, nestedPath));
        }
      });
    } else if (typeof rawNested === "object") {
      const obj = rawNested as Record<string, unknown>;
      if (isReference(obj)) continue;
      const nestedType = getTypes(obj)[0];
      const nestedPath = path ? `${path}.${prop}` : prop;
      if (
        nestedType &&
        allowedTypes.length &&
        !allowedTypes.includes(nestedType)
      ) {
        messages.push({
          kind: "error",
          message: `${prefix}Property "${prop}" expected @type one of [${allowedTypes.join(", ")}], got ${nestedType} (${primaryType})`,
        });
      }
      messages.push(...validateBlock(obj, options, nestedPath));
    }
  }
  if (strict) {
    for (const key of Object.keys(block)) {
      if (key.startsWith("@")) continue;
      if (!knownProperties.has(key)) {
        messages.push({
          kind: "warning",
          message: `${prefix}Unknown property: ${key} (${primaryType})`,
        });
      }
    }
  }
  return messages;
};

/** Flatten @graph and return all top-level nodes for validation */
export const getBlocksToValidate = (
  block: Record<string, unknown>,
): Record<string, unknown>[] => {
  const graph = block["@graph"];
  if (Array.isArray(graph)) {
    return graph.filter(
      (n): n is Record<string, unknown> => n !== null && typeof n === "object",
    );
  }
  return [block];
};
