package handlers

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// BlobHandler handles profile picture uploads
type BlobHandler struct {
	blobSvc     *services.BlobService
	blobClient  *azblob.Client
	container   string
	accountName string
}

// NewBlobHandler creates a new BlobHandler
func NewBlobHandler(blobSvc *services.BlobService, cfg *config.AzureStorageConfig) (*BlobHandler, error) {
	handler := &BlobHandler{
		blobSvc:     blobSvc,
		container:   cfg.ContainerName,
		accountName: cfg.AccountName,
	}

	if cfg.ConnectionString == "" {
		return handler, nil // Blob storage disabled
	}

	client, err := azblob.NewClientFromConnectionString(cfg.ConnectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create blob client: %w", err)
	}

	handler.blobClient = client

	// Create container if it doesn't exist
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, err = client.CreateContainer(ctx, cfg.ContainerName, nil)
	if err != nil && !strings.Contains(err.Error(), "ContainerAlreadyExists") {
		logger.Sugar.Warnf("Container creation warning: %v", err)
	}

	logger.Sugar.Info("Azure Blob Storage initialized successfully")
	return handler, nil
}

// IsEnabled returns whether blob storage is configured
func (h *BlobHandler) IsEnabled() bool {
	return h.blobClient != nil
}

// UploadProfilePicture handles profile picture uploads
func (h *BlobHandler) UploadProfilePicture(c *fiber.Ctx) error {
	if h.blobClient == nil {
		return response.ServiceUnavailable(c, "Profile picture upload is not configured")
	}

	userID := getUserID(c)

	// Get file from form
	file, err := c.FormFile("image")
	if err != nil {
		return response.BadRequest(c, "No image file provided", constants.ErrCodeInvalidRequest)
	}

	// Validate file size
	if file.Size > constants.MaxProfilePicSize {
		return response.BadRequest(c, "Image size must be less than 5MB", constants.ErrCodeInvalidRequest)
	}

	// Validate file type
	ext := strings.ToLower(filepath.Ext(file.Filename))
	if !constants.AllowedImageExtensions[ext] {
		return response.BadRequest(c, "Only JPG, PNG, WebP, and HEIC images are allowed", constants.ErrCodeInvalidRequest)
	}

	// Open the file
	src, err := file.Open()
	if err != nil {
		return response.InternalError(c, "Failed to read image file", constants.ErrCodeServerError)
	}
	defer src.Close()

	// Process image (validate, resize to 1080px max, generate 200x200 thumbnail)
	imgProcessor := services.NewImageProcessorWithOptions(1080, 200, 85)
	processed, err := imgProcessor.Process(src, file)
	if err != nil {
		logger.Sugar.Warnw("Profile picture processing failed", "userID", userID, "error", err)
		return response.BadRequest(c, "Failed to process image: "+err.Error(), constants.ErrCodeInvalidRequest)
	}

	// Generate unique blob names (always JPEG after processing)
	photoUUID := uuid.New().String()
	fullBlobName := fmt.Sprintf("%d/%s.jpg", userID, photoUUID)
	thumbBlobName := fmt.Sprintf("%d/%s_thumb.jpg", userID, photoUUID)

	// Delete old profile picture blobs if exist
	user, err := h.blobSvc.GetUser(userID)
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	h.deleteOldProfilePicBlobs(user)

	// Upload full image to Azure Blob Storage
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	jpegContentType := "image/jpeg"
	_, err = h.blobClient.UploadStream(ctx, h.container, fullBlobName, processed.Full, &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &jpegContentType,
		},
	})
	if err != nil {
		logger.Sugar.Errorw("Failed to upload profile pic blob", "error", err)
		return response.InternalError(c, "Failed to upload image", constants.ErrCodeServerError)
	}

	// Upload thumbnail
	_, err = h.blobClient.UploadStream(ctx, h.container, thumbBlobName, processed.Thumbnail, &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &jpegContentType,
		},
	})
	if err != nil {
		// Clean up full image on thumbnail upload failure
		_, _ = h.blobClient.DeleteBlob(ctx, h.container, fullBlobName, nil)
		logger.Sugar.Errorw("Failed to upload profile pic thumbnail", "error", err)
		return response.InternalError(c, "Failed to upload image", constants.ErrCodeServerError)
	}

	// Generate public URLs
	imageURL := h.generateBlobURL(fullBlobName)
	thumbURL := h.generateBlobURL(thumbBlobName)

	// Update user's profile picture URLs
	if err := h.blobSvc.UpdateProfilePic(userID, &imageURL, &thumbURL); err != nil {
		return response.InternalError(c, "Failed to update profile", constants.ErrCodeUpdateFailed)
	}

	logger.Sugar.Infow("Profile picture uploaded",
		"userID", userID,
		"fullURL", imageURL,
		"thumbURL", thumbURL,
		"fullSizeBytes", processed.FullSize,
		"thumbSizeBytes", processed.ThumbSize,
	)

	return response.JSON(c, fiber.Map{
		"success":           true,
		"profile_pic":       imageURL,
		"profile_pic_thumb": thumbURL,
	})
}

// generateBlobURL creates the public URL for a blob
// Uses Azurite endpoint in development, Azure in production
func (h *BlobHandler) generateBlobURL(blobName string) string {
	cfg := config.AppConfig

	if cfg != nil && cfg.IsDevelopment() {
		// Azurite local emulator URL (accessible from host machine)
		return fmt.Sprintf("http://localhost:10000/devstoreaccount1/%s/%s", h.container, blobName)
	}

	// Production Azure Blob Storage URL
	return fmt.Sprintf("https://%s.blob.core.windows.net/%s/%s", h.accountName, h.container, blobName)
}

// DeleteProfilePicture handles profile picture deletion
func (h *BlobHandler) DeleteProfilePicture(c *fiber.Ctx) error {
	userID := getUserID(c)

	user, err := h.blobSvc.GetUser(userID)
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	// Delete both full and thumbnail blobs from Azure Blob Storage
	h.deleteOldProfilePicBlobs(user)

	// Clear profile picture URLs
	if err := h.blobSvc.UpdateProfilePic(userID, nil, nil); err != nil {
		return response.InternalError(c, "Failed to update profile", constants.ErrCodeUpdateFailed)
	}

	logger.Sugar.Infow("Profile picture deleted", "userID", userID)
	return response.Success(c, constants.MsgProfilePicDeleted)
}

// deleteOldProfilePicBlobs deletes both the full and thumbnail blobs for a user's existing profile picture
func (h *BlobHandler) deleteOldProfilePicBlobs(user *models.User) {
	if h.blobClient == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Delete full image blob
	if user.ProfilePic != nil && *user.ProfilePic != "" {
		blobName := h.extractBlobName(*user.ProfilePic)
		if blobName != "" {
			if _, err := h.blobClient.DeleteBlob(ctx, h.container, blobName, nil); err != nil {
				logger.Sugar.Warnw("Failed to delete old profile pic blob", "error", err, "blobName", blobName)
			}
		}
	}

	// Delete thumbnail blob
	if user.ProfilePicThumb != nil && *user.ProfilePicThumb != "" {
		thumbBlobName := h.extractBlobName(*user.ProfilePicThumb)
		if thumbBlobName != "" {
			if _, err := h.blobClient.DeleteBlob(ctx, h.container, thumbBlobName, nil); err != nil {
				logger.Sugar.Warnw("Failed to delete old profile pic thumbnail blob", "error", err, "blobName", thumbBlobName)
			}
		}
	}
}

func (h *BlobHandler) extractBlobName(url string) string {
	// Handle both Azure and Azurite URLs:
	// Azure: https://{account}.blob.core.windows.net/{container}/{blob}
	// Azurite: http://localhost:10000/devstoreaccount1/{container}/{blob}
	parts := strings.Split(url, h.container+"/")
	if len(parts) >= 2 {
		return parts[len(parts)-1]
	}
	return ""
}
