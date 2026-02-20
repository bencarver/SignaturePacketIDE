import { GoogleGenAI, Type, Schema } from "@google/genai";
import { SignatureBlockExtraction } from "../types";

const SYSTEM_INSTRUCTION = `
You are a specialized legal AI assistant for transaction lawyers.
Your task is to analyze an image of a document page and identify if it is a "Signature Page" (or "Execution Page").

### CRITICAL DEFINITIONS FOR EXTRACTION

1. **PARTY**: The legal entity OR individual person who is a party to the contract.
   - For COMPANIES: Found in headings like "EXECUTED by ABC HOLDINGS LIMITED" or "ABC CORP:". The company name is the party.
   - For INDIVIDUALS: The label above the signature line (e.g. "KEY HOLDER:", "FOUNDER:", "GUARANTOR:", "INVESTOR:") is a ROLE, NOT the party name. The party is the INDIVIDUAL'S NAME printed below or beside the signature line.
   - NEVER use a role label like "Key Holder", "Founder", "Guarantor", "Investor" as the party name when a person's name is present.
   - If the only name present is a person's name (e.g. "John Smith"), use that as the party name.

2. **SIGNATORY**: The human being physically signing the page.
   - For companies: the named officer/director signing on behalf of the company (found under "Name:", "By:", or "Signed by:").
   - For individuals signing in their personal capacity: the signatory IS the same person as the party. Use their name for BOTH partyName and signatoryName.
   - A company name (e.g. "Acme Corp") can NEVER be a signatory.

3. **CAPACITY**: The role or authority of the signatory.
   - For company signatories: "Director", "CEO", "Authorised Signatory", "General Partner", etc.
   - For individuals signing personally: use the label from the block (e.g. "Key Holder", "Founder", "Guarantor") as the capacity, NOT as the party name.

### COMMON INDIVIDUAL SIGNATURE BLOCK PATTERN (very important):
\`\`\`
KEY HOLDER:

______________________________
John Smith
\`\`\`
→ partyName: "John Smith", signatoryName: "John Smith", capacity: "Key Holder"

### COMMON COMPANY SIGNATURE BLOCK PATTERN:
\`\`\`
ACME CORP:

By: ______________________________
Name: Jane Smith
Title: Director
\`\`\`
→ partyName: "Acme Corp", signatoryName: "Jane Smith", capacity: "Director"

### RULES
1. If this is a signature page, set isSignaturePage to true.
2. Extract ALL signature blocks found on the page.
3. For each block, strictly separate the **Party Name** (Entity or Individual), **Signatory Name** (Human), and **Capacity** (Title/Role).
4. If a field is blank (e.g. "Name: _______"), leave the extracted value as empty string.
5. If it is NOT a signature page (e.g. text clauses only), set isSignaturePage to false.
`;

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    isSignaturePage: {
      type: Type.BOOLEAN,
      description: "True if the page contains a signature block for execution."
    },
    signatures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          partyName: {
            type: Type.STRING,
            description: "The legal entity or individual who is a party to the contract. For companies: the company name. For individuals: the person's actual name (e.g. 'John Smith'), NOT their role label (e.g. NOT 'Key Holder' or 'Founder')."
          },
          signatoryName: {
             type: Type.STRING,
             description: "The human name of the person physically signing. For individuals signing personally, this is the same as partyName. Never use a company name here."
          },
          capacity: {
            type: Type.STRING,
            description: "The title or role of the signatory. For company signatories: 'Director', 'CEO', etc. For individuals signing personally: use their block label, e.g. 'Key Holder', 'Founder', 'Guarantor'."
          }
        }
      }
    }
  },
  required: ["isSignaturePage", "signatures"]
};

export const analyzePage = async (
  base64Image: string,
  modelName: string = 'gemini-2.5-flash'
): Promise<SignatureBlockExtraction> => {
  // Remove data:image/jpeg;base64, prefix if present
  const cleanBase64 = base64Image.split(',')[1];

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: cleanBase64
            }
          },
          {
            text: "Analyze this page. Is it a signature page? Extract the Party, Signatory, and Capacity according to the definitions."
          }
        ]
      },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    return JSON.parse(text) as SignatureBlockExtraction;

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    // Fallback safe return
    return {
      isSignaturePage: false,
      signatures: []
    };
  }
};