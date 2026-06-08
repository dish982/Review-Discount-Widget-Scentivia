import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const app = express();
app.use(express.json());

// Set up memory storage for handling file streams via Multer
const upload = multer({
  storage: multer.memoryStorage()
});

// Enable CORS so your Shopify store frontend can talk to your backend
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT;

/**
 * Step 1: Request Staged Upload Target from Shopify
 */
async function uploadToShopify(file) {
  const query = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
      }
    }
  `;

  const variables = {
    input: [
      {
        resource: "FILE",
        filename: file.originalname,
        mimeType: file.mimetype,
        httpMethod: "POST"
      }
    ]
  };

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  console.log("FILE CREATE RESPONSE:", JSON.stringify(json, null, 2));
  return json.data.stagedUploadsCreate.stagedTargets[0];
}

/**
 * Step 3: Finalize Staged S3 Asset inside Shopify Files
 */
async function finalizeFileInShopify(filename, resourceUrl) {
  const query = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    files: [
      {
        alt: "Customer Review Photo",
        contentType: "IMAGE",
        originalSource: resourceUrl
      }
    ]
  };

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  
  if (json.errors || (json.data?.fileCreate?.userErrors && json.data.fileCreate.userErrors.length > 0)) {
    console.error("Shopify File Creation Error:", json.errors || json.data.fileCreate.userErrors);
    return null;
  }

  // Returns the structural permanent reference GID: gid://shopify/MediaImage/...
  return json.data.fileCreate.files[0].id;
}

/**
 * Express Route: Handles Review Submissions, Media Uploads, Metaobjects, & Discounts
 */
app.post("/api/submit-review", upload.array("photos", 5), async (req, res) => {
  try {
    console.log("Incoming Payload Body:", req.body);
    console.log("Number of Files Attached:", req.files ? req.files.length : 0);

    const {
      customer_name,
      customer_email,
      rating,
      review_text,
      product
    } = req.body;

    // Baseline validation guard
    if (!customer_name || !customer_email || !rating || !review_text || !product) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required parameters inside the payload stream." 
      });
    }

    let uploadedImageGids = [];

    // Process file uploads if files exist
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        console.log(`Processing asset: ${file.originalname}`);

        // 1. Get staging parameters from Shopify
        const target = await uploadToShopify(file);

                // 2. Stream Binary direct to Amazon S3
        const formData = new FormData();

        // IMPORTANT: append all params first
        for (const param of target.parameters) {
          formData.append(param.name, param.value);
        }

        // IMPORTANT: last field MUST be file
        formData.append(
          "file",
          new Blob([file.buffer], { type: file.mimetype }),
          file.originalname
        );

        const uploadRes = await fetch(target.url, {
          method: "POST",
          body: formData
        });

        console.log("UPLOAD STATUS:", uploadRes.status);
        console.log("UPLOAD OK:", uploadRes.ok);

        // 3. Register the S3 staging resource as a permanent Shopify file asset
        console.log(`Finalizing ${file.originalname} into Shopify File Library...`);
        const permanentGid = await finalizeFileInShopify(file.originalname, target.resourceUrl);
        
        if (permanentGid) {
          uploadedImageGids.push(permanentGid);
          console.log(`File registered under GID: ${permanentGid}`);
        }
      }
    }

    // Generate unique 10% coupon code string
    const uniqueId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const calculatedCouponCode = `REVIEW-${uniqueId}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Core GraphQL Bundle Mutation
    const mutationQuery = `
      mutation CreateReviewAndDiscount($metaobject: MetaobjectCreateInput!, $discount: DiscountCodeBasicInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
            handle
          }
          userErrors {
            field
            message
          }
        }
        discountCodeBasicCreate(basicCodeDiscount: $discount) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

      // delete discount mutation query
  const updateMetaobjectMutation = `
mutation UpdateReviewMetaobject(
  $id: ID!,
  $metaobject: MetaobjectUpdateInput!
) {
  metaobjectUpdate(
    id: $id,
    metaobject: $metaobject
  ) {
    metaobject {
      id
    }
    userErrors {
      field
      message
    }
  }
}
`;

    if (req.files?.length && uploadedImageGids.length === 0) {
      return res.status(500).json({
        success: false,
        error: "Image upload failed, aborting metaobject creation"
      });
    }

    // Map input fields to match Shopify Metaobject validations & structures 
    const mutationVariables = {
      metaobject: {
        type: "reviews",
        capabilities: {
          publishable: {
            status: "ACTIVE"
          }
        },
        fields: [
          { key: "customer_name", value: customer_name },
          { key: "customer_email", value: customer_email },
          { key: "rating", value: String(parseInt(rating)) },
          { key: "review_text", value: review_text },
          { key: "product", value: product },
          {
            key: "review_images",
            value: JSON.stringify(uploadedImageGids)
          },
        ]
      },
      discount: {
        title: `Review Reward - ${customer_email}`,
        code: calculatedCouponCode,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt.toISOString(),
        customerSelection: {
          all: true
        },
        customerGets: {
          value: {
            percentage: 0.10
          },
          items: {
            all: true
          }
        },
        appliesOncePerCustomer: true,
        usageLimit: 1
      }
    };

    // Execute GraphQL transaction call
    const shopifyResponse = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify({
        query: mutationQuery,
        variables: mutationVariables
      })
    });

    const responseBody = await shopifyResponse.json();

    if (responseBody.errors) {
      console.error("Shopify Core GraphQL System Errors:", responseBody.errors);
      return res.status(500).json({ success: false, error: "GraphQL Core compilation schema failure." });
    }

    const { metaobjectCreate, discountCodeBasicCreate } = responseBody.data;

    // Check for Metaobject operational constraints/validation bugs
    if (metaobjectCreate.userErrors && metaobjectCreate.userErrors.length > 0) {
      console.error("Metaobject Creation User Errors:", metaobjectCreate.userErrors);
      return res.status(422).json({ 
        success: false, 
        error: `Metaobject Field Mismatch: ${metaobjectCreate.userErrors[0].message}` 
      });
    }

    // Check for Discount creation errors (e.g., duplicated key)
    if (discountCodeBasicCreate.userErrors && discountCodeBasicCreate.userErrors.length > 0) {
      console.error("Discount Code Creation User Errors:", discountCodeBasicCreate.userErrors);
      return res.status(422).json({ 
        success: false, 
        error: `Discount Creation Failure: ${discountCodeBasicCreate.userErrors[0].message}` 
      });
    }

    const metaobjectId = metaobjectCreate.metaobject.id;
    const discountNodeId = discountCodeBasicCreate.codeDiscountNode.id;


    const updateVariables = {
      id: metaobjectId,
      metaobject: {
        fields: [
          {
            key: "discount_id",
            value: discountNodeId
          },
          {
            key: "discount_expire_at",
            value: expiresAt.toISOString()
          },
          {
            key: "created_date",
            value: new Date().toISOString()
          }
        ]
      }
    };

    const updateResponse = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify({
        query: updateMetaobjectMutation,
        variables: updateVariables
      })
    });

    const updateBody = await updateResponse.json();

    console.log(`Review sync complete for ${customer_name}. Code Generated: ${calculatedCouponCode}`);
    
    return res.status(200).json({
      success: true,
      metaobjectId: metaobjectCreate.metaobject.id,
      couponCode: calculatedCouponCode,
      expiresAt: expiresAt.toISOString()
    });

  } catch (globalCatchError) {
    console.error("Critical Server Exception:", globalCatchError);
    return res.status(500).json({ 
      success: false, 
      error: "Internal server pipeline error." 
    });
  }
});

app.get("/api/get-reviews", async (req, res) => {
  try {
    const query = `
      query {
        metaobjects(type: "reviews", first: 20) {
          edges {
            node {
              id
              fields {
                key
                value
              }
            }
          }
        }
      }
    `;

    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify({ query })
    });

    const json = await response.json();


    const reviews = json.data.metaobjects.edges.map(async (edge) => {
    const fields = {};

    edge.node.fields.forEach(f => {
      fields[f.key] = f.value;
    });

    let imageUrl = null;

    if (fields.review_images) {
      const imgQuery = `
        query {
          node(id: "${fields.review_images}") {
            ... on MediaImage {
              image {
                url
              }
            }
            ... on GenericFile {
              url
            }
          }
        }
      `;

      const imgRes = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify({ query: imgQuery })
      });

      const imgJson = await imgRes.json();
      const node = imgJson?.data?.node;

      imageUrl =
        node?.image?.url ||
        node?.url ||
        null;
          }

    return {
      id: edge.node.id,
      ...fields,
      review_images_url: imageUrl
    };
  });
  const resolvedReviews = await Promise.all(reviews);
  return res.status(200).json({
  success: true,
  reviews: resolvedReviews
});

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: "failed to fetch reviews"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Review Bridge Server cleanly running on port ${PORT}`));