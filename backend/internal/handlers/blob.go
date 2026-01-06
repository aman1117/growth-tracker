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

	// Generate unique blob name
	blobName := fmt.Sprintf("%d/%s%s", userID, uuid.New().String(), ext)

	// Delete old profile picture if exists
	user, err := h.blobSvc.GetUser(userID)
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if user.ProfilePic != nil && *user.ProfilePic != "" {
		oldBlobName := h.extractBlobName(*user.ProfilePic)
		if oldBlobName != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, _ = h.blobClient.DeleteBlob(ctx, h.container, oldBlobName, nil)
			cancel()
		}
	}

	// Upload to Azure Blob Storage
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	contentType := constants.ImageContentTypes[ext]
	_, err = h.blobClient.UploadStream(ctx, h.container, blobName, src, &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &contentType,
		},
	})
	if err != nil {
		logger.Sugar.Errorw("Failed to upload blob", "error", err)
		return response.InternalError(c, "Failed to upload image", constants.ErrCodeServerError)
	}

	// Generate public URL - uses Azurite in development, Azure in production
	imageURL := h.generateBlobURL(blobName)

	// Update user's profile picture URL
	if err := h.blobSvc.UpdateProfilePic(userID, &imageURL); err != nil {
		return response.InternalError(c, "Failed to update profile", constants.ErrCodeUpdateFailed)
	}

	logger.Sugar.Infow("Profile picture uploaded", "userID", userID, "url", imageURL)

	return response.JSON(c, fiber.Map{
		"success":     true,
		"profile_pic": imageURL,
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

	// Delete from Azure Blob Storage
	if h.blobClient != nil && user.ProfilePic != nil && *user.ProfilePic != "" {
		blobName := h.extractBlobName(*user.ProfilePic)
		if blobName != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, err := h.blobClient.DeleteBlob(ctx, h.container, blobName, nil)
			cancel()
			if err != nil {
				logger.Sugar.Warnw("Failed to delete blob", "error", err, "blobName", blobName)
			}
		}
	}

	// Clear profile picture URL
	if err := h.blobSvc.UpdateProfilePic(userID, nil); err != nil {
		return response.InternalError(c, "Failed to update profile", constants.ErrCodeUpdateFailed)
	}

	logger.Sugar.Infow("Profile picture deleted", "userID", userID)
	return response.Success(c, constants.MsgProfilePicDeleted)
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
