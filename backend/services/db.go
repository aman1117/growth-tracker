package services

import (
	"errors"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

func CreateUser(email, username, password string) error {
	db := utils.GetDB()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	result := db.Exec("INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)", email, username, string(hash))
	return result.Error
}

func GetUserByIdentifier(identifier string) (*models.User, error) {
	db := utils.GetDB()
	user := &models.User{}
	result := db.Where("email = ? OR username = ?", identifier, identifier).First(&user)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, result.Error
	}
	return user, nil
}

func UpdateUsername(userID uint, newUsername string) error {
	db := utils.GetDB()
	result := db.Model(&models.User{}).Where("id = ?", userID).Update("username", newUsername)
	return result.Error
}

func UpdatePrivacy(userID uint, isPrivate bool) error {
	db := utils.GetDB()
	result := db.Model(&models.User{}).Where("id = ?", userID).Update("is_private", isPrivate)
	return result.Error
}

func GetUserPrivacy(userID uint) (bool, error) {
	db := utils.GetDB()
	var user models.User
	if err := db.Where("id = ?", userID).First(&user).Error; err != nil {
		return false, err
	}
	return user.IsPrivate, nil
}

func GetUserByID(userID uint) (*models.User, error) {
	db := utils.GetDB()
	var user models.User
	if err := db.Where("id = ?", userID).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

func UpdateUserPassword(userID uint, hashedPassword string) error {
	db := utils.GetDB()
	result := db.Model(&models.User{}).Where("id = ?", userID).Update("password_hash", hashedPassword)
	return result.Error
}

func UpdateBio(userID uint, bio string) error {
	db := utils.GetDB()
	var bioPtr *string
	if bio != "" {
		bioPtr = &bio
	}
	result := db.Model(&models.User{}).Where("id = ?", userID).Update("bio", bioPtr)
	return result.Error
}

func GetUserBio(userID uint) (*string, error) {
	db := utils.GetDB()
	var user models.User
	if err := db.Where("id = ?", userID).First(&user).Error; err != nil {
		return nil, err
	}
	return user.Bio, nil
}
