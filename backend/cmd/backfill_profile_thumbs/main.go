//go:build ignore
// +build ignore

// Backfill script to generate thumbnails for existing user profile pictures.
// Run with: go run cmd/backfill_profile_thumbs/main.go
//
// Required environment variables:
// - DB_HOST, DB_PORT (default: 5432), DB_NAME, DB_USER, DB_PASSWORD, DB_SSL_MODE (default: require)
// - AZURE_STORAGE_CONNECTION_STRING: connection string for blob storage
// - AZURE_STORAGE_CONTAINER: blob container name (default: profile-pictures)
//
// This script:
// 1. Queries users with profile_pic set but profile_pic_thumb = NULL
// 2. Downloads each image from blob storage
// 3. Generates a 200x200 JPEG thumbnail
// 4. Uploads the thumbnail alongside the original
// 5. Updates the profile_pic_thumb column
//
// Safe to run multiple times (idempotent).
package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/disintegration/imaging"
	"golang.org/x/image/webp"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const (
	batchSize     = 50
	thumbnailSize = 200
	jpegQuality   = 85
	httpTimeout   = 30 * time.Second
)

type userRow struct {
	ID         uint
	ProfilePic string
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	dbHost := getEnv("DB_HOST", "")
	dbPort := getEnv("DB_PORT", "5432")
	dbName := getEnv("DB_NAME", "")
	dbUser := getEnv("DB_USER", "")
	dbPassword := getEnv("DB_PASSWORD", "")
	dbSSLMode := getEnv("DB_SSL_MODE", "require")
	connStr := getEnv("AZURE_STORAGE_CONNECTION_STRING", "")
	container := getEnv("AZURE_STORAGE_CONTAINER", "profile-pictures")

	if dbHost == "" || dbName == "" || dbUser == "" || dbPassword == "" {
		log.Fatal("Missing required DB environment variables")
	}
	if connStr == "" {
		log.Fatal("AZURE_STORAGE_CONNECTION_STRING is required")
	}

	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		dbHost, dbPort, dbName, dbUser, dbPassword, dbSSLMode)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	blobClient, err := azblob.NewClientFromConnectionString(connStr, nil)
	if err != nil {
		log.Fatalf("Failed to create blob client: %v", err)
	}

	httpClient := &http.Client{Timeout: httpTimeout}

	log.Println("Starting profile picture thumbnail backfill...")

	var totalProcessed, totalSkipped, totalFailed int

	for {
		var users []userRow
		// No OFFSET needed: successfully processed rows drop out of the WHERE clause,
		// so we always query from the start. Failed rows will be retried.
		err := db.Raw(`
			SELECT id, profile_pic
			FROM users
			WHERE profile_pic IS NOT NULL
			  AND profile_pic != ''
			  AND (profile_pic_thumb IS NULL OR profile_pic_thumb = '')
			ORDER BY id
			LIMIT ?
		`, batchSize).Scan(&users).Error

		if err != nil {
			log.Fatalf("Failed to query users: %v", err)
		}
		if len(users) == 0 {
			break
		}

		log.Printf("Processing batch of %d users...", len(users))

		batchFailed := 0
		for _, u := range users {
			thumbURL, err := processUser(httpClient, blobClient, container, u)
			if err != nil {
				log.Printf("  SKIP user %d: %v", u.ID, err)
				totalFailed++
				batchFailed++
				continue
			}

			if err := db.Exec("UPDATE users SET profile_pic_thumb = ? WHERE id = ?", thumbURL, u.ID).Error; err != nil {
				log.Printf("  FAIL user %d: DB update error: %v", u.ID, err)
				totalFailed++
				batchFailed++
				continue
			}

			log.Printf("  OK user %d: %s", u.ID, thumbURL)
			totalProcessed++
		}

		// If entire batch failed, stop to avoid infinite loop
		if batchFailed == len(users) {
			log.Printf("Entire batch failed, stopping to avoid infinite loop")
			break
		}
	}

	log.Printf("Backfill complete: %d processed, %d skipped/failed, %d total",
		totalProcessed, totalFailed, totalProcessed+totalFailed+totalSkipped)
}

func processUser(httpClient *http.Client, blobClient *azblob.Client, container string, u userRow) (string, error) {
	// Download existing image
	resp, err := httpClient.Get(u.ProfilePic)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	imgData, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read body failed: %w", err)
	}

	// Detect format and decode
	contentType := resp.Header.Get("Content-Type")
	var img image.Image

	switch {
	case strings.Contains(contentType, "jpeg") || strings.Contains(contentType, "jpg"):
		img, err = jpeg.Decode(bytes.NewReader(imgData))
	case strings.Contains(contentType, "png"):
		img, err = png.Decode(bytes.NewReader(imgData))
	case strings.Contains(contentType, "webp"):
		img, err = webp.Decode(bytes.NewReader(imgData))
	default:
		// Try generic decode
		img, _, err = image.Decode(bytes.NewReader(imgData))
	}
	if err != nil {
		return "", fmt.Errorf("decode failed (type=%s): %w", contentType, err)
	}

	// Generate thumbnail: center crop to square, then resize
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	minDim := w
	if h < w {
		minDim = h
	}
	thumbImg := imaging.CropCenter(img, minDim, minDim)
	thumbImg = imaging.Resize(thumbImg, thumbnailSize, thumbnailSize, imaging.Lanczos)

	var thumbBuf bytes.Buffer
	if err := jpeg.Encode(&thumbBuf, thumbImg, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", fmt.Errorf("encode thumbnail failed: %w", err)
	}

	// Derive thumb blob name from original URL
	thumbBlobName, err := deriveThumbBlobName(u.ProfilePic, container)
	if err != nil {
		return "", err
	}

	// Upload thumbnail
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	jpegContentType := "image/jpeg"
	_, err = blobClient.UploadStream(ctx, container, thumbBlobName, bytes.NewReader(thumbBuf.Bytes()), &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &jpegContentType,
		},
	})
	if err != nil {
		return "", fmt.Errorf("upload thumbnail failed: %w", err)
	}

	// Generate thumb URL (same base as original, but with _thumb suffix)
	thumbURL := deriveThumbURL(u.ProfilePic, thumbBlobName, container)
	return thumbURL, nil
}

// deriveThumbBlobName creates the thumbnail blob name from the original URL.
// e.g., "42/abc-def.jpg" → "42/abc-def_thumb.jpg"
// or "42/abc-def.png" → "42/abc-def_thumb.jpg" (always JPEG output)
func deriveThumbBlobName(originalURL, container string) (string, error) {
	parts := strings.Split(originalURL, container+"/")
	if len(parts) < 2 {
		return "", fmt.Errorf("cannot extract blob name from URL: %s", originalURL)
	}
	blobName := parts[len(parts)-1]

	// Remove extension and add _thumb.jpg
	dotIdx := strings.LastIndex(blobName, ".")
	if dotIdx == -1 {
		return blobName + "_thumb.jpg", nil
	}
	return blobName[:dotIdx] + "_thumb.jpg", nil
}

// deriveThumbURL constructs the thumb URL by replacing the blob name portion of the original URL
func deriveThumbURL(originalURL, thumbBlobName, container string) string {
	parts := strings.Split(originalURL, container+"/")
	if len(parts) < 2 {
		return originalURL // fallback
	}
	return parts[0] + container + "/" + thumbBlobName
}
