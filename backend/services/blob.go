package services

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

var blobClient *azblob.Client
var containerName = "profile-pictures"

// InitBlobStorage initializes Azure Blob Storage client
func InitBlobStorage() error {
	connectionString := utils.GetFromEnv("AZURE_STORAGE_CONNECTION_STRING")
	if connectionString == "" {
		utils.Sugar.Warn("AZURE_STORAGE_CONNECTION_STRING not set, profile picture upload disabled")
		return nil
	}

	client, err := azblob.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return fmt.Errorf("failed to create blob client: %w", err)
	}

	blobClient = client

	// Create container if it doesn't exist
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, err = blobClient.CreateContainer(ctx, containerName, nil)
	if err != nil && !strings.Contains(err.Error(), "ContainerAlreadyExists") {
		utils.Sugar.Warnf("Container creation warning: %v", err)
	}

	utils.Sugar.Info("Azure Blob Storage initialized successfully")
	return nil
}

// UploadProfilePictureHandler handles profile picture uploads
func UploadProfilePictureHandler(c *fiber.Ctx) error {
	if blobClient == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"success": false,
			"error":   "Profile picture upload is not configured",
		})
	}

	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Unauthorized",
		})
	}

	// Get file from form
	file, err := c.FormFile("image")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "No image file provided",
		})
	}

	// Validate file size (max 5MB)
	if file.Size > 5*1024*1024 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Image size must be less than 5MB",
		})
	}

	// Validate file type
	ext := strings.ToLower(filepath.Ext(file.Filename))
	allowedExts := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".heic": true, ".heif": true}
	if !allowedExts[ext] {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Only JPG, PNG, WebP, and HEIC images are allowed",
		})
	}

	// Open the file
	src, err := file.Open()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to read image file",
		})
	}
	defer src.Close()

	// Generate unique blob name
	blobName := fmt.Sprintf("%d/%s%s", userID, uuid.New().String(), ext)

	// Delete old profile picture if exists
	var user models.User
	db := utils.GetDB()
	if err := db.First(&user, userID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success": false,
			"error":   "User not found",
		})
	}

	if user.ProfilePic != nil && *user.ProfilePic != "" {
		// Extract blob name from URL and delete
		oldBlobName := extractBlobName(*user.ProfilePic)
		if oldBlobName != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, _ = blobClient.DeleteBlob(ctx, containerName, oldBlobName, nil)
			cancel()
		}
	}

	// Upload to Azure Blob Storage
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	contentType := getContentType(ext)
	_, err = blobClient.UploadStream(ctx, containerName, blobName, src, &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &contentType,
		},
	})
	if err != nil {
		utils.Sugar.Errorw("Failed to upload blob", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to upload image",
		})
	}

	// Generate public URL
	accountName := utils.GetFromEnv("AZURE_STORAGE_ACCOUNT_NAME")
	imageURL := fmt.Sprintf("https://%s.blob.core.windows.net/%s/%s", accountName, containerName, blobName)

	// Update user's profile picture URL in database
	if err := db.Model(&user).Update("profile_pic", imageURL).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to update profile",
		})
	}

	utils.Sugar.Infow("Profile picture uploaded", "userID", userID, "url", imageURL)

	return c.JSON(fiber.Map{
		"success":     true,
		"profile_pic": imageURL,
	})
}

// DeleteProfilePictureHandler removes the user's profile picture
func DeleteProfilePictureHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Unauthorized",
		})
	}

	db := utils.GetDB()
	var user models.User
	if err := db.First(&user, userID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success": false,
			"error":   "User not found",
		})
	}

	// Delete from Azure Blob Storage if exists
	if blobClient != nil && user.ProfilePic != nil && *user.ProfilePic != "" {
		blobName := extractBlobName(*user.ProfilePic)
		if blobName != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, err := blobClient.DeleteBlob(ctx, containerName, blobName, nil)
			cancel()
			if err != nil {
				utils.Sugar.Warnw("Failed to delete blob", "error", err, "blobName", blobName)
			}
		}
	}

	// Clear profile picture URL in database
	if err := db.Model(&user).Update("profile_pic", nil).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to update profile",
		})
	}

	utils.Sugar.Infow("Profile picture deleted", "userID", userID)

	return c.JSON(fiber.Map{
		"success": true,
	})
}

// GetProfileHandler returns the user's profile including profile picture
func GetProfileHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Unauthorized",
		})
	}

	db := utils.GetDB()
	var user models.User
	if err := db.First(&user, userID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success": false,
			"error":   "User not found",
		})
	}

	return c.JSON(fiber.Map{
		"success":     true,
		"profile_pic": user.ProfilePic,
		"username":    user.Username,
		"email":       user.Email,
		"bio":         user.Bio,
	})
}

// Helper function to extract blob name from URL
func extractBlobName(url string) string {
	// URL format: https://{account}.blob.core.windows.net/{container}/{blobName}
	parts := strings.Split(url, containerName+"/")
	if len(parts) == 2 {
		return parts[1]
	}
	return ""
}

// Helper function to get content type from extension
func getContentType(ext string) string {
	contentTypes := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".webp": "image/webp",
		".heic": "image/heic",
		".heif": "image/heif",
	}
	if ct, ok := contentTypes[ext]; ok {
		return ct
	}
	return "application/octet-stream"
}

// Wrapper for multipart file reader
type fileReader struct {
	file multipart.File
}

func (r *fileReader) Read(p []byte) (n int, err error) {
	return r.file.Read(p)
}

func (r *fileReader) Close() error {
	return r.file.Close()
}

func (r *fileReader) Seek(offset int64, whence int) (int64, error) {
	seeker, ok := r.file.(io.Seeker)
	if !ok {
		return 0, fmt.Errorf("file does not support seeking")
	}
	return seeker.Seek(offset, whence)
}
