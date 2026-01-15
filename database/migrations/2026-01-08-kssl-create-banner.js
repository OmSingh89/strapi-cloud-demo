"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Download an image from a URL
 */
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const options = url.startsWith("https") 
      ? { rejectUnauthorized: false } // Bypass SSL certificate validation
      : {};
    
    protocol.get(url, options, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirects
        return downloadImage(response.headers.location).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Upload image buffer to Strapi media library using provider
 */
async function uploadImageToStrapi(buffer, filename, alt) {
  const uploadService = strapi.plugin('upload').service('upload');
  
  // Write buffer to temporary file
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, filename);
  fs.writeFileSync(tempFilePath, buffer);

  try {
    const stats = fs.statSync(tempFilePath);
    const stream = fs.createReadStream(tempFilePath);
    
    // Use the provider to upload
    const provider = strapi.plugin('upload').provider;
    const file = {
      name: filename.replace(/\.[^/.]+$/, ""),
      alternativeText: alt,
      caption: alt,
      hash: `${Date.now()}_${filename.replace(/\.[^/.]+$/, "")}`,
      ext: path.extname(filename),
      mime: filename.endsWith('.webp') ? 'image/webp' : filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      size: (stats.size / 1024).toFixed(2),
      buffer: buffer,
      stream: stream,
      path: tempFilePath,
    };

    // Upload file to storage
    await provider.upload(file);
    
    // Save to database
    const uploadedFile = await strapi.query('plugin::upload.file').create({
      data: {
        name: file.name,
        alternativeText: file.alternativeText,
        caption: file.caption,
        hash: file.hash,
        ext: file.ext,
        mime: file.mime,
        size: parseFloat(file.size),
        url: file.url,
        provider: provider.name || 'local',
      },
    });

    // Clean up temp file
    fs.unlinkSync(tempFilePath);

    return uploadedFile;
  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    throw error;
  }
}

async function up() {
  // Ensure the underlying table exists before using the entity service
  const hasBannersTable =
    await strapi.db.connection.schema.hasTable("banners");
  if (!hasBannersTable) {
    console.log("⏭️  Skipping: banners table not ready yet.");
    return;
  }

  // Skip if banners already present
  const existing = await strapi.documents("api::banner.banner").findMany({
    limit: 1,
    status: "draft",
  });
  if (existing && existing.length) {
    console.log("Banner data already exists, skipping migration.");
    return;
  }

  // Banner data to import
  const bannersData = [
    {
      Title: "Welcome",
      imageUrl: "https://www.techmonitor.ai/wp-content/uploads/sites/29/2017/02/shutterstock_552493561-2048x1366.webp",
      imageAlt: "Hero",
      CTALabel: "Start",
      CTAUrl: "/start",
    },
    {
      Title: "Welcome two",
      imageUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSV8jDeR8_JWiDCtdwH3Ke39AiBsq1RZL6drQ&s",
      imageAlt: "Hero two",
      CTALabel: "Start two",
      CTAUrl: "/starttwo",
    },
  ];

  // Create Banners using Strapi entity service within a transaction
  await strapi.db.transaction(async ({ trx }) => {
    for (const bannerData of bannersData) {
      let uploadedImage = null;

      // Download and upload image
      try {
        console.log(`📥 Downloading image from ${bannerData.imageUrl}...`);
        const imageBuffer = await downloadImage(bannerData.imageUrl);
        
        const filename = `banner-${bannerData.Title.toLowerCase().replace(/\s+/g, '-')}.webp`;
        console.log(`📤 Uploading ${filename} to Strapi...`);
        
        uploadedImage = await uploadImageToStrapi(
          imageBuffer,
          filename,
          bannerData.imageAlt
        );
        
        console.log(`✅ Image uploaded successfully (ID: ${uploadedImage.id})`);
      } catch (error) {
        console.error(`❌ Failed to process image: ${error.message}`);
        // Continue without image if upload fails
      }

      // Create banner with or without image
      await strapi.documents("api::banner.banner").create({
        data: {
          Title: bannerData.Title,
          CTALabel: bannerData.CTALabel,
          CTAUrl: bannerData.CTAUrl,
          Image: uploadedImage?.id || null,
          publishedAt: new Date().toISOString(),
        },
        transacting: trx,
      });
    }
  });

  console.log(
    `✅ Banner migration completed successfully - ${bannersData.length} banners created`
  );
}

module.exports = { up };
