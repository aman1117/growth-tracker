// Package services contains business logic for activity photos (stories).
package services

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// IST timezone location
var istLocation *time.Location

func init() {
	var err error
	istLocation, err = time.LoadLocation(constants.TimezoneIST)
	if err != nil {
		// Fallback to UTC+5:30 if timezone data is not available
		istLocation = time.FixedZone("IST", 5*60*60+30*60)
	}
}

// ActivityPhotoService handles activity photo business logic
type ActivityPhotoService struct {
	repo            *repository.ActivityPhotoRepository
	userRepo        *repository.UserRepository
	followRepo      *repository.FollowRepository
	notificationSvc *NotificationService
	imageProcessor  *ImageProcessor
	blobClient      *azblob.Client
	container       string
	accountName     string

	// Debounce notification state
	pendingNotifications map[uint]*pendingPhotoNotification
	notificationMutex    sync.Mutex
}

// pendingPhotoNotification tracks photos uploaded within the debounce window
type pendingPhotoNotification struct {
	uploaderID       uint
	uploaderUsername string
	uploaderAvatar   string
	photoDate        string
	photoCount       int
	timer            *time.Timer
}

// NewActivityPhotoService creates a new ActivityPhotoService
func NewActivityPhotoService(
	repo *repository.ActivityPhotoRepository,
	userRepo *repository.UserRepository,
	followRepo *repository.FollowRepository,
	notificationSvc *NotificationService,
	cfg *config.AzureStorageConfig,
) (*ActivityPhotoService, error) {
	svc := &ActivityPhotoService{
		repo:                 repo,
		userRepo:             userRepo,
		followRepo:           followRepo,
		notificationSvc:      notificationSvc,
		imageProcessor:       NewImageProcessor(),
		container:            cfg.ContainerName,
		accountName:          cfg.AccountName,
		pendingNotifications: make(map[uint]*pendingPhotoNotification),
	}

	if cfg.ConnectionString != "" {
		client, err := azblob.NewClientFromConnectionString(cfg.ConnectionString, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create blob client: %w", err)
		}
		svc.blobClient = client
	}

	return svc, nil
}

// Upload uploads a new activity photo
func (s *ActivityPhotoService) Upload(
	ctx context.Context,
	userID uint,
	activityName string,
	photoDate time.Time,
	file multipart.File,
	fileHeader *multipart.FileHeader,
	activityIcon string,
	activityColor string,
	activityLabel string,
) (*models.ActivityPhoto, error) {
	// Validate date is within 7 days (IST)
	if err := s.validatePhotoDate(photoDate); err != nil {
		return nil, err
	}

	// Validate file size (5MB max)
	if fileHeader.Size > constants.MaxProfilePicSize {
		return nil, fmt.Errorf("image size must be less than 5MB")
	}

	// Check for existing photo
	existing, err := s.repo.GetExisting(userID, activityName, photoDate)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing photo: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("photo already exists for this activity on this date")
	}

	// Process image (validate, resize, generate thumbnail)
	processed, err := s.imageProcessor.Process(file, fileHeader)
	if err != nil {
		return nil, fmt.Errorf("failed to process image: %w", err)
	}

	// Generate blob names
	dateStr := photoDate.Format("2006-01-02")
	photoUUID := uuid.New().String()
	basePath := fmt.Sprintf("activity-photos/%d/%s/%s", userID, dateStr, activityName)
	fullBlobName := fmt.Sprintf("%s/%s.jpg", basePath, photoUUID)
	thumbBlobName := fmt.Sprintf("%s/%s_thumb.jpg", basePath, photoUUID)

	// Upload to Azure Blob Storage
	if s.blobClient == nil {
		return nil, fmt.Errorf("blob storage is not configured")
	}

	// Upload full image
	fullURL, err := s.uploadBlob(ctx, fullBlobName, processed.Full, processed.MimeType)
	if err != nil {
		return nil, fmt.Errorf("failed to upload full image: %w", err)
	}

	// Upload thumbnail
	thumbURL, err := s.uploadBlob(ctx, thumbBlobName, processed.Thumbnail, processed.MimeType)
	if err != nil {
		// Try to clean up full image
		s.deleteBlob(ctx, fullBlobName)
		return nil, fmt.Errorf("failed to upload thumbnail: %w", err)
	}

	// Create database record with optional custom tile metadata
	photo := &models.ActivityPhoto{
		UserID:       userID,
		ActivityName: activityName,
		PhotoDate:    photoDate,
		PhotoURL:     fullURL,
		ThumbnailURL: thumbURL,
	}

	// Store custom tile metadata if provided (for custom activities)
	if activityIcon != "" {
		photo.ActivityIcon = &activityIcon
	}
	if activityColor != "" {
		photo.ActivityColor = &activityColor
	}
	if activityLabel != "" {
		photo.ActivityLabel = &activityLabel
	}

	if err := s.repo.Create(photo); err != nil {
		// Clean up blobs on DB failure
		s.deleteBlob(ctx, fullBlobName)
		s.deleteBlob(ctx, thumbBlobName)
		return nil, fmt.Errorf("failed to save photo: %w", err)
	}

	// Trigger debounced notification to followers
	go s.scheduleNotification(ctx, userID, dateStr)

	logger.Sugar.Infow("Activity photo uploaded",
		"user_id", userID,
		"activity_name", activityName,
		"photo_date", dateStr,
		"photo_id", photo.ID,
	)

	return photo, nil
}

// validatePhotoDate checks if the photo date is within 7 days (IST timezone)
func (s *ActivityPhotoService) validatePhotoDate(photoDate time.Time) error {
	now := time.Now().In(istLocation)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, istLocation)

	// Photo date should be normalized to IST midnight
	photoDateIST := time.Date(photoDate.Year(), photoDate.Month(), photoDate.Day(), 0, 0, 0, 0, istLocation)

	// Cannot be in the future
	if photoDateIST.After(today) {
		return fmt.Errorf("cannot upload photo for future date")
	}

	// Must be within last 7 days
	sevenDaysAgo := today.AddDate(0, 0, -7)
	if photoDateIST.Before(sevenDaysAgo) {
		return fmt.Errorf("can only upload photos for the last 7 days")
	}

	return nil
}

// uploadBlob uploads data to Azure Blob Storage and returns the URL
func (s *ActivityPhotoService) uploadBlob(ctx context.Context, blobName string, data io.Reader, contentType string) (string, error) {
	uploadCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	_, err := s.blobClient.UploadStream(uploadCtx, s.container, blobName, data, &azblob.UploadStreamOptions{
		HTTPHeaders: &blob.HTTPHeaders{
			BlobContentType: &contentType,
		},
	})
	if err != nil {
		return "", err
	}

	return s.generateBlobURL(blobName), nil
}

// deleteBlob removes a blob from storage
func (s *ActivityPhotoService) deleteBlob(ctx context.Context, blobName string) {
	deleteCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	_, err := s.blobClient.DeleteBlob(deleteCtx, s.container, blobName, nil)
	if err != nil {
		logger.Sugar.Warnw("Failed to delete blob", "blob_name", blobName, "error", err)
	}
}

// generateBlobURL creates the public URL for a blob
func (s *ActivityPhotoService) generateBlobURL(blobName string) string {
	cfg := config.AppConfig
	if cfg != nil && cfg.IsDevelopment() {
		return fmt.Sprintf("http://localhost:10000/devstoreaccount1/%s/%s", s.container, blobName)
	}
	return fmt.Sprintf("https://%s.blob.core.windows.net/%s/%s", s.accountName, s.container, blobName)
}

// extractBlobName extracts blob name from URL
func (s *ActivityPhotoService) extractBlobName(url string) string {
	parts := strings.Split(url, s.container+"/")
	if len(parts) >= 2 {
		return parts[len(parts)-1]
	}
	return ""
}

// Delete removes a photo and its blobs
func (s *ActivityPhotoService) Delete(ctx context.Context, photoID, userID uint) error {
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return fmt.Errorf("failed to get photo: %w", err)
	}
	if photo == nil {
		return fmt.Errorf("photo not found")
	}
	if photo.UserID != userID {
		return fmt.Errorf("not authorized to delete this photo")
	}

	// Delete blobs
	if fullBlobName := s.extractBlobName(photo.PhotoURL); fullBlobName != "" {
		s.deleteBlob(ctx, fullBlobName)
	}
	if thumbBlobName := s.extractBlobName(photo.ThumbnailURL); thumbBlobName != "" {
		s.deleteBlob(ctx, thumbBlobName)
	}

	// Delete from database (cascade deletes StoryViews)
	if err := s.repo.Delete(photoID); err != nil {
		return fmt.Errorf("failed to delete photo: %w", err)
	}

	logger.Sugar.Infow("Activity photo deleted",
		"photo_id", photoID,
		"user_id", userID,
	)

	return nil
}

// DeleteByActivity deletes all photos for a specific activity (used when custom tile is deleted)
func (s *ActivityPhotoService) DeleteByActivity(ctx context.Context, userID uint, activityName string) error {
	// Get all photos for this activity
	photos, err := s.repo.GetByActivityName(userID, activityName)
	if err != nil {
		return fmt.Errorf("failed to get photos: %w", err)
	}

	// Delete each photo's blobs
	for _, photo := range photos {
		if fullBlobName := s.extractBlobName(photo.PhotoURL); fullBlobName != "" {
			s.deleteBlob(ctx, fullBlobName)
		}
		if thumbBlobName := s.extractBlobName(photo.ThumbnailURL); thumbBlobName != "" {
			s.deleteBlob(ctx, thumbBlobName)
		}
	}

	// Delete from database
	if err := s.repo.DeleteByUserAndActivity(userID, activityName); err != nil {
		return fmt.Errorf("failed to delete photos: %w", err)
	}

	logger.Sugar.Infow("Activity photos deleted for tile",
		"user_id", userID,
		"activity_name", activityName,
		"count", len(photos),
	)

	return nil
}

// GetByUserAndDate retrieves photos for a user on a specific date
func (s *ActivityPhotoService) GetByUserAndDate(ctx context.Context, userID uint, photoDate time.Time) ([]models.ActivityPhoto, error) {
	return s.repo.GetByUserAndDate(userID, photoDate)
}

// GetFollowingStories retrieves story groups from users the viewer follows
func (s *ActivityPhotoService) GetFollowingStories(ctx context.Context, viewerID uint, photoDate time.Time, limit int) ([]models.UserStoryGroup, error) {
	return s.repo.GetFollowingPhotosGrouped(viewerID, photoDate, limit)
}

// RecordView records that a user viewed a photo
func (s *ActivityPhotoService) RecordView(ctx context.Context, viewerID, photoID uint) error {
	// Don't record self-views
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return err
	}
	if photo == nil {
		return fmt.Errorf("photo not found")
	}
	if photo.UserID == viewerID {
		return nil // Don't record viewing own photo
	}

	return s.repo.RecordView(viewerID, photoID)
}

// GetViewers retrieves viewers of a photo
func (s *ActivityPhotoService) GetViewers(ctx context.Context, photoID, ownerID uint, limit, offset int) ([]models.PhotoViewer, int64, error) {
	// Verify ownership
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return nil, 0, err
	}
	if photo == nil {
		return nil, 0, fmt.Errorf("photo not found")
	}
	if photo.UserID != ownerID {
		return nil, 0, fmt.Errorf("not authorized to view photo viewers")
	}

	return s.repo.GetViewers(photoID, limit, offset)
}

// GetViewCount returns the view count for a photo
func (s *ActivityPhotoService) GetViewCount(ctx context.Context, photoID uint) (int64, error) {
	return s.repo.GetViewCount(photoID)
}

// GetByID retrieves a photo by ID
func (s *ActivityPhotoService) GetByID(ctx context.Context, photoID uint) (*models.ActivityPhoto, error) {
	return s.repo.GetByID(photoID)
}

// CanViewStories checks if a viewer can view a user's stories
func (s *ActivityPhotoService) CanViewStories(ctx context.Context, viewerID, targetUserID uint) (bool, error) {
	if viewerID == targetUserID {
		return true, nil // Can always view own stories
	}

	// Check if viewer follows the target
	isFollowing, err := s.followRepo.IsFollowing(viewerID, targetUserID)
	if err != nil {
		return false, err
	}

	return isFollowing, nil
}

// ==================== Story Likes ====================

// LikePhoto likes a photo (also records view) and sends notification to owner
// Follows the same idempotency pattern as LikeDay - check first, return early if already liked
func (s *ActivityPhotoService) LikePhoto(ctx context.Context, likerID, photoID uint) error {
	// Get the photo
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return fmt.Errorf("failed to get photo: %w", err)
	}
	if photo == nil {
		return fmt.Errorf("photo not found")
	}

	// Cannot like own photo
	if photo.UserID == likerID {
		return fmt.Errorf("cannot like own photo")
	}

	// Check if liker follows the photo owner
	canView, err := s.CanViewStories(ctx, likerID, photo.UserID)
	if err != nil {
		return fmt.Errorf("failed to check permissions: %w", err)
	}
	if !canView {
		return fmt.Errorf("must follow user to like their photos")
	}

	// Check if already liked - return early if so (no notification, no cache update)
	alreadyLiked, err := s.repo.HasLikedPhoto(likerID, photoID)
	if err != nil {
		logger.Sugar.Warnw("Failed to check existing like", "error", err, "photo_id", photoID, "liker_id", likerID)
	}

	if alreadyLiked {
		logger.Sugar.Infow("Photo already liked, returning early",
			"photo_id", photoID,
			"liker_id", likerID,
		)
		return nil // Already liked - idempotent, no error
	}

	// Create the like (handles duplicate gracefully at DB level too)
	if err := s.repo.LikePhoto(likerID, photoID); err != nil {
		return fmt.Errorf("failed to like photo: %w", err)
	}

	// Also record a view (liking counts as viewing)
	if err := s.repo.RecordView(likerID, photoID); err != nil {
		logger.Sugar.Warnw("Failed to record view on like", "error", err, "photo_id", photoID, "liker_id", likerID)
	}

	// Update cache
	redis.IncrementStoryLikeCount(ctx, photoID)
	redis.SetStoryLikedByUser(ctx, photoID, likerID, true)

	// Send notification to photo owner (async)
	go s.sendLikeNotification(ctx, likerID, photo)

	logger.Sugar.Infow("Photo liked",
		"photo_id", photoID,
		"liker_id", likerID,
		"owner_id", photo.UserID,
	)

	return nil
}

// UnlikePhoto removes a like from a photo
func (s *ActivityPhotoService) UnlikePhoto(ctx context.Context, likerID, photoID uint) error {
	// Get the photo
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return fmt.Errorf("failed to get photo: %w", err)
	}
	if photo == nil {
		return fmt.Errorf("photo not found")
	}

	// Remove the like
	if err := s.repo.UnlikePhoto(likerID, photoID); err != nil {
		return fmt.Errorf("failed to unlike photo: %w", err)
	}

	// Update cache
	redis.DecrementStoryLikeCount(ctx, photoID)
	redis.SetStoryLikedByUser(ctx, photoID, likerID, false)

	logger.Sugar.Infow("Photo unliked",
		"photo_id", photoID,
		"liker_id", likerID,
	)

	return nil
}

// HasLikedPhoto checks if a user has liked a photo
func (s *ActivityPhotoService) HasLikedPhoto(ctx context.Context, likerID, photoID uint) (bool, error) {
	// Check cache first
	liked, found, err := redis.GetStoryLikedByUser(ctx, photoID, likerID)
	if err != nil {
		logger.Sugar.Warnw("Failed to get liked status from cache", "error", err)
	}
	if found {
		return liked, nil
	}

	// Cache miss - check DB
	liked, err = s.repo.HasLikedPhoto(likerID, photoID)
	if err != nil {
		return false, err
	}

	// Update cache
	redis.SetStoryLikedByUser(ctx, photoID, likerID, liked)

	return liked, nil
}

// GetPhotoLikeCount returns the like count for a photo
func (s *ActivityPhotoService) GetPhotoLikeCount(ctx context.Context, photoID uint) (int64, error) {
	// Check cache first
	count, err := redis.GetStoryLikeCount(ctx, photoID)
	if err != nil {
		logger.Sugar.Warnw("Failed to get like count from cache", "error", err)
	}
	if count >= 0 {
		return count, nil
	}

	// Cache miss - get from DB
	count, err = s.repo.GetPhotoLikeCount(photoID)
	if err != nil {
		return 0, err
	}

	// Update cache
	redis.SetStoryLikeCount(ctx, photoID, count)

	return count, nil
}

// GetPhotoLikers retrieves likers of a photo (owner only)
func (s *ActivityPhotoService) GetPhotoLikers(ctx context.Context, photoID, ownerID uint, limit, offset int) ([]models.PhotoLiker, int64, error) {
	// Verify ownership
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return nil, 0, err
	}
	if photo == nil {
		return nil, 0, fmt.Errorf("photo not found")
	}
	if photo.UserID != ownerID {
		return nil, 0, fmt.Errorf("not authorized to view photo likers")
	}

	return s.repo.GetPhotoLikers(photoID, limit, offset)
}

// GetPhotoInteractions retrieves combined viewers and likers (owner only)
func (s *ActivityPhotoService) GetPhotoInteractions(ctx context.Context, photoID, ownerID uint, limit, offset int) ([]models.PhotoInteraction, int64, error) {
	// Verify ownership
	photo, err := s.repo.GetByID(photoID)
	if err != nil {
		return nil, 0, err
	}
	if photo == nil {
		return nil, 0, fmt.Errorf("photo not found")
	}
	if photo.UserID != ownerID {
		return nil, 0, fmt.Errorf("not authorized to view photo interactions")
	}

	return s.repo.GetPhotoInteractions(photoID, limit, offset)
}

// sendLikeNotification sends push notification to photo owner when someone likes their photo
// Uses NotificationDedupe table to ensure "only once ever" delivery per (recipient, liker, photo) combination.
// Safe for unlike/re-like scenarios - user will only receive one notification ever per photo+liker pair.
func (s *ActivityPhotoService) sendLikeNotification(ctx context.Context, likerID uint, photo *models.ActivityPhoto) {
	// Create fresh context for background operation
	sendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Get liker info
	liker, err := s.userRepo.FindByID(likerID)
	if err != nil || liker == nil {
		logger.Sugar.Warnw("Failed to get liker for notification", "liker_id", likerID, "error", err)
		return
	}

	var likerAvatar string
	if liker.ProfilePic != nil {
		likerAvatar = *liker.ProfilePic
	}

	// Build entity key for dedupe: "photoID"
	entityKey := fmt.Sprintf("%d", photo.ID)
	photoDateStr := photo.PhotoDate.Format(constants.DateFormat)

	// Use transaction to ensure atomicity of dedupe check + notification create
	db := s.repo.GetDB()
	var notif *models.Notification

	txErr := db.WithContext(sendCtx).Transaction(func(tx *gorm.DB) error {
		// 1. Try to insert dedupe record with ON CONFLICT DO NOTHING
		dedupe := &models.NotificationDedupe{
			UserID:     photo.UserID,
			ActorID:    likerID,
			Type:       models.NotifTypeStoryLiked,
			EntityType: "story_like",
			EntityKey:  entityKey,
		}

		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)
		if result.Error != nil {
			logger.Sugar.Errorw("Failed to create story like dedupe record",
				"user_id", photo.UserID,
				"actor_id", likerID,
				"entity_key", entityKey,
				"error", result.Error,
			)
			return result.Error
		}

		// 2. If dedupe record already existed (conflict), skip notification
		if result.RowsAffected == 0 {
			logger.Sugar.Debugw("Skipping duplicate story like notification",
				"user_id", photo.UserID,
				"actor_id", likerID,
				"entity_key", entityKey,
			)
			return nil
		}

		// 3. Create the notification
		body := fmt.Sprintf("%s liked your story", liker.Username)
		notif = &models.Notification{
			UserID: photo.UserID,
			Type:   models.NotifTypeStoryLiked,
			Title:  "New Like!",
			Body:   body,
			Metadata: models.StoryLikedMetadata{
				LikerID:       likerID,
				LikerUsername: liker.Username,
				LikerAvatar:   likerAvatar,
				PhotoID:       photo.ID,
				PhotoDate:     photoDateStr,
			}.ToMap(),
		}

		if err := tx.Create(notif).Error; err != nil {
			logger.Sugar.Errorw("Failed to create story like notification in transaction",
				"user_id", photo.UserID,
				"type", notif.Type,
				"error", err,
			)
			return err
		}

		logger.Sugar.Infow("Story like notification created",
			"id", notif.ID,
			"photo_id", photo.ID,
			"liker_id", likerID,
			"owner_id", photo.UserID,
		)

		return nil
	})

	if txErr != nil {
		logger.Sugar.Warnw("Transaction failed for story like notification",
			"photo_id", photo.ID,
			"liker_id", likerID,
			"owner_id", photo.UserID,
			"error", txErr,
		)
		return
	}

	// If notif is nil, dedupe record already existed (no notification created)
	if notif == nil {
		return
	}

	// Publish push notification (outside transaction)
	if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
		pushDedupeKey := fmt.Sprintf("story_liked:%d:%d:%d", photo.UserID, likerID, photo.ID)
		ttlSeconds := 14400 // 4 hours
		deepLink := fmt.Sprintf("/user/%s?date=%s", liker.Username, photoDateStr)

		data := notif.Metadata
		if data == nil {
			data = make(map[string]interface{})
		}
		data["notification_id"] = notif.ID

		if err := publisher.PublishPushNotification(
			sendCtx,
			photo.UserID,
			notif.Type,
			notif.Title,
			notif.Body,
			pushDedupeKey,
			deepLink,
			data,
			ttlSeconds,
		); err != nil {
			logger.Sugar.Warnw("Failed to publish push notification for story like",
				"notif_id", notif.ID,
				"owner_id", photo.UserID,
				"error", err,
			)
		}
	}
}

// ==================== Debounced Notifications ====================

const notificationDebounceWindow = 30 * time.Second

// scheduleNotification schedules a debounced notification for photo uploads
func (s *ActivityPhotoService) scheduleNotification(ctx context.Context, uploaderID uint, photoDate string) {
	s.notificationMutex.Lock()
	defer s.notificationMutex.Unlock()

	key := uploaderID

	// Check if there's already a pending notification
	if pending, exists := s.pendingNotifications[key]; exists {
		// Increment photo count
		pending.photoCount++
		// Reset timer
		pending.timer.Reset(notificationDebounceWindow)
		logger.Sugar.Debugw("Debounced notification updated",
			"uploader_id", uploaderID,
			"photo_count", pending.photoCount,
		)
		return
	}

	// Get uploader info
	uploader, err := s.userRepo.FindByID(uploaderID)
	if err != nil || uploader == nil {
		logger.Sugar.Warnw("Failed to get uploader for notification",
			"uploader_id", uploaderID,
			"error", err,
		)
		return
	}

	var avatar string
	if uploader.ProfilePic != nil {
		avatar = *uploader.ProfilePic
	}

	// Create new pending notification
	pending := &pendingPhotoNotification{
		uploaderID:       uploaderID,
		uploaderUsername: uploader.Username,
		uploaderAvatar:   avatar,
		photoDate:        photoDate,
		photoCount:       1,
	}

	// IMPORTANT: Use background context for the timer callback, not the request context.
	// The request context will be cancelled when the HTTP request completes,
	// but the timer fires 5 minutes later, so we need a fresh context.
	pending.timer = time.AfterFunc(notificationDebounceWindow, func() {
		// Create a fresh context with timeout for the notification sending
		sendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.sendPhotoNotification(sendCtx, pending)
	})

	s.pendingNotifications[key] = pending

	logger.Sugar.Debugw("Scheduled debounced notification",
		"uploader_id", uploaderID,
		"photo_date", photoDate,
	)
}

// sendPhotoNotification sends the actual notification to followers
func (s *ActivityPhotoService) sendPhotoNotification(ctx context.Context, pending *pendingPhotoNotification) {
	s.notificationMutex.Lock()
	delete(s.pendingNotifications, pending.uploaderID)
	s.notificationMutex.Unlock()

	// Get all follower IDs of the uploader
	followerIDs, err := s.followRepo.GetAllFollowerIDs(pending.uploaderID)
	if err != nil {
		logger.Sugar.Errorw("Failed to get followers for notification",
			"uploader_id", pending.uploaderID,
			"error", err,
		)
		return
	}

	if len(followerIDs) == 0 {
		return
	}

	// Format the date nicely
	formattedDate := pending.photoDate
	if parsedDate, err := time.Parse("2006-01-02", pending.photoDate); err == nil {
		formattedDate = parsedDate.Format("2 Jan, 2006")
	}

	// Create notification body
	body := fmt.Sprintf("%s shared a new photo", pending.uploaderUsername)
	if pending.photoCount > 1 {
		body = fmt.Sprintf("%s shared %d new photos", pending.uploaderUsername, pending.photoCount)
	}

	// Deep link to uploader's profile with date
	deepLink := fmt.Sprintf("/user/%s?date=%s", pending.uploaderUsername, pending.photoDate)

	// Send notification to each follower
	for _, followerID := range followerIDs {
		notif := &models.Notification{
			UserID: followerID,
			Type:   models.NotifTypePhotoUploaded,
			Title:  "New Story!",
			Body:   body,
			Metadata: models.PhotoUploadedMetadata{
				UploaderID:       pending.uploaderID,
				UploaderUsername: pending.uploaderUsername,
				UploaderAvatar:   pending.uploaderAvatar,
				PhotoCount:       pending.photoCount,
				PhotoDate:        pending.photoDate,
			}.ToMap(),
		}

		if err := s.notificationSvc.Create(ctx, notif); err != nil {
			logger.Sugar.Warnw("Failed to create photo notification",
				"follower_id", followerID,
				"uploader_id", pending.uploaderID,
				"error", err,
			)
			continue
		}

		// Publish push notification (bypasses push preferences for story notifications)
		if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
			pushDedupeKey := fmt.Sprintf("photo_uploaded:%d:%d:%s", followerID, pending.uploaderID, pending.photoDate)
			ttlSeconds := 14400 // 4 hours

			data := notif.Metadata
			if data == nil {
				data = make(map[string]interface{})
			}
			data["notification_id"] = notif.ID

			if err := publisher.PublishPushNotification(
				ctx,
				followerID,
				notif.Type,
				notif.Title,
				notif.Body,
				pushDedupeKey,
				deepLink,
				data,
				ttlSeconds,
			); err != nil {
				logger.Sugar.Warnw("Failed to publish push notification for photo upload",
					"notif_id", notif.ID,
					"follower_id", followerID,
					"error", err,
				)
				// Non-fatal, in-app notification is still delivered
			}
		}
	}

	logger.Sugar.Infow("Photo notifications sent",
		"uploader_id", pending.uploaderID,
		"photo_count", pending.photoCount,
		"follower_count", len(followerIDs),
		"date", formattedDate,
	)
}
