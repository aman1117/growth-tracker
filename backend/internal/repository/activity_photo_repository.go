// Package repository provides data access layer for activity photos.
package repository

import (
	"errors"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ActivityPhotoRepository handles activity photo data operations
type ActivityPhotoRepository struct {
	db *gorm.DB
}

// NewActivityPhotoRepository creates a new ActivityPhotoRepository
func NewActivityPhotoRepository(db *gorm.DB) *ActivityPhotoRepository {
	return &ActivityPhotoRepository{db: db}
}

// GetDB returns the underlying database connection
func (r *ActivityPhotoRepository) GetDB() *gorm.DB {
	return r.db
}

// Create creates a new activity photo
func (r *ActivityPhotoRepository) Create(photo *models.ActivityPhoto) error {
	return r.db.Create(photo).Error
}

// GetByID retrieves a photo by ID
func (r *ActivityPhotoRepository) GetByID(id uint) (*models.ActivityPhoto, error) {
	var photo models.ActivityPhoto
	if err := r.db.Where("id = ?", id).First(&photo).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &photo, nil
}

// GetByUserAndDate retrieves all photos for a user on a specific date
func (r *ActivityPhotoRepository) GetByUserAndDate(userID uint, photoDate time.Time) ([]models.ActivityPhoto, error) {
	var photos []models.ActivityPhoto
	err := r.db.Where("user_id = ? AND photo_date = ?", userID, photoDate).
		Order("activity_name ASC").
		Find(&photos).Error
	return photos, err
}

// GetByUserAndDateRange retrieves all photos for a user within a date range
func (r *ActivityPhotoRepository) GetByUserAndDateRange(userID uint, startDate, endDate time.Time) ([]models.ActivityPhoto, error) {
	var photos []models.ActivityPhoto
	err := r.db.Where("user_id = ? AND photo_date >= ? AND photo_date <= ?", userID, startDate, endDate).
		Order("photo_date DESC, activity_name ASC").
		Find(&photos).Error
	return photos, err
}

// GetByActivityName retrieves photos for a specific activity name by user
func (r *ActivityPhotoRepository) GetByActivityName(userID uint, activityName string) ([]models.ActivityPhoto, error) {
	var photos []models.ActivityPhoto
	err := r.db.Where("user_id = ? AND activity_name = ?", userID, activityName).
		Order("photo_date DESC").
		Find(&photos).Error
	return photos, err
}

// GetFollowingPhotos retrieves photos from users that the viewer follows for a specific date
func (r *ActivityPhotoRepository) GetFollowingPhotos(viewerID uint, photoDate time.Time, limit, offset int) ([]models.ActivityPhoto, error) {
	var photos []models.ActivityPhoto
	err := r.db.Raw(`
		SELECT ap.* FROM activity_photos ap
		INNER JOIN follow_edges_by_follower fe ON ap.user_id = fe.followee_id
		WHERE fe.follower_id = ? 
		AND fe.state = 'ACTIVE'
		AND ap.photo_date = ?
		ORDER BY ap.created_at DESC
		LIMIT ? OFFSET ?
	`, viewerID, photoDate, limit, offset).Scan(&photos).Error
	return photos, err
}

// GetFollowingPhotosGrouped retrieves photos grouped by user for a specific date
func (r *ActivityPhotoRepository) GetFollowingPhotosGrouped(viewerID uint, photoDate time.Time, limit int) ([]models.UserStoryGroup, error) {
	// First get unique users with photos, ordered by most recent upload
	var userIDs []uint
	err := r.db.Raw(`
		SELECT user_id FROM (
			SELECT ap.user_id, MAX(ap.created_at) as latest_upload
			FROM activity_photos ap
			INNER JOIN follow_edges_by_follower fe ON ap.user_id = fe.followee_id
			WHERE fe.follower_id = ? 
			AND fe.state = 'ACTIVE'
			AND ap.photo_date = ?
			GROUP BY ap.user_id
			ORDER BY latest_upload DESC
			LIMIT ?
		) sub
	`, viewerID, photoDate, limit).Scan(&userIDs).Error
	if err != nil {
		return nil, err
	}

	// For each user, get their photos and user info
	var groups []models.UserStoryGroup
	for _, userID := range userIDs {
		var user struct {
			ID         uint
			Username   string
			ProfilePic *string
		}
		if err := r.db.Raw("SELECT id, username, profile_pic FROM users WHERE id = ?", userID).Scan(&user).Error; err != nil {
			continue
		}

		var photos []models.ActivityPhoto
		if err := r.db.Where("user_id = ? AND photo_date = ?", userID, photoDate).
			Order("created_at ASC"). // Order by time: older first, newer last
			Find(&photos).Error; err != nil {
			continue
		}

		// Get viewed photo IDs for this viewer
		var viewedPhotoIDs []uint
		r.db.Raw(`
			SELECT photo_id FROM story_views 
			WHERE viewer_id = ? AND photo_id IN (
				SELECT id FROM activity_photos WHERE user_id = ? AND photo_date = ?
			)
		`, viewerID, userID, photoDate).Scan(&viewedPhotoIDs)

		viewedSet := make(map[uint]bool)
		for _, id := range viewedPhotoIDs {
			viewedSet[id] = true
		}

		// Convert photos to ActivityPhotoInStory with view status
		photosWithViewed := make([]models.ActivityPhotoInStory, len(photos))
		hasUnseen := false
		for i, photo := range photos {
			viewed := viewedSet[photo.ID]
			if !viewed {
				hasUnseen = true
			}
			photosWithViewed[i] = models.ActivityPhotoInStory{
				ActivityPhoto: photo,
				Viewed:        viewed,
			}
		}

		groups = append(groups, models.UserStoryGroup{
			UserID:     user.ID,
			Username:   user.Username,
			ProfilePic: user.ProfilePic,
			Photos:     photosWithViewed,
			HasUnseen:  hasUnseen,
		})
	}

	return groups, nil
}

// Delete deletes a photo by ID
func (r *ActivityPhotoRepository) Delete(id uint) error {
	return r.db.Delete(&models.ActivityPhoto{}, id).Error
}

// DeleteByUserAndActivity deletes all photos for a user's specific activity
// Used when a custom tile is deleted
func (r *ActivityPhotoRepository) DeleteByUserAndActivity(userID uint, activityName string) error {
	return r.db.Where("user_id = ? AND activity_name = ?", userID, activityName).
		Delete(&models.ActivityPhoto{}).Error
}

// Exists checks if a photo exists for a user, activity, and date
func (r *ActivityPhotoRepository) Exists(userID uint, activityName string, photoDate time.Time) (bool, error) {
	var count int64
	err := r.db.Model(&models.ActivityPhoto{}).
		Where("user_id = ? AND activity_name = ? AND photo_date = ?", userID, activityName, photoDate).
		Count(&count).Error
	return count > 0, err
}

// GetExisting retrieves an existing photo for a user, activity, and date
func (r *ActivityPhotoRepository) GetExisting(userID uint, activityName string, photoDate time.Time) (*models.ActivityPhoto, error) {
	var photo models.ActivityPhoto
	err := r.db.Where("user_id = ? AND activity_name = ? AND photo_date = ?", userID, activityName, photoDate).
		First(&photo).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &photo, err
}

// ==================== Story Views ====================

// RecordView records that a user viewed a photo (upsert)
func (r *ActivityPhotoRepository) RecordView(viewerID, photoID uint) error {
	view := &models.StoryView{
		ViewerID: viewerID,
		PhotoID:  photoID,
	}
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(view).Error
}

// HasViewed checks if a user has viewed a photo
func (r *ActivityPhotoRepository) HasViewed(viewerID, photoID uint) (bool, error) {
	var count int64
	err := r.db.Model(&models.StoryView{}).
		Where("viewer_id = ? AND photo_id = ?", viewerID, photoID).
		Count(&count).Error
	return count > 0, err
}

// GetViewers retrieves all viewers of a photo with their user info
func (r *ActivityPhotoRepository) GetViewers(photoID uint, limit, offset int) ([]models.PhotoViewer, int64, error) {
	var viewers []models.PhotoViewer
	err := r.db.Raw(`
		SELECT 
			u.id as user_id, 
			u.username, 
			u.profile_pic,
			sv.viewed_at
		FROM story_views sv
		INNER JOIN users u ON sv.viewer_id = u.id
		WHERE sv.photo_id = ?
		ORDER BY sv.viewed_at DESC
		LIMIT ? OFFSET ?
	`, photoID, limit, offset).Scan(&viewers).Error
	if err != nil {
		return nil, 0, err
	}

	var total int64
	r.db.Model(&models.StoryView{}).Where("photo_id = ?", photoID).Count(&total)

	return viewers, total, nil
}

// GetViewCount returns the number of views for a photo
func (r *ActivityPhotoRepository) GetViewCount(photoID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.StoryView{}).Where("photo_id = ?", photoID).Count(&count).Error
	return count, err
}

// GetViewedPhotoIDs returns IDs of photos that a user has viewed
func (r *ActivityPhotoRepository) GetViewedPhotoIDs(viewerID uint, photoIDs []uint) ([]uint, error) {
	if len(photoIDs) == 0 {
		return []uint{}, nil
	}
	var viewedIDs []uint
	err := r.db.Model(&models.StoryView{}).
		Select("photo_id").
		Where("viewer_id = ? AND photo_id IN ?", viewerID, photoIDs).
		Scan(&viewedIDs).Error
	return viewedIDs, err
}
