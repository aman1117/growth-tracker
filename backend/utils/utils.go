package utils

import (
	"context"
	"errors"
	"log"
	"os"
	"strconv"
	"time"

	"fmt"

	"github.com/aman1117/backend/models"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Claims struct {
	UserID   uint   `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

func GetDB() *gorm.DB {
	err := godotenv.Load()
	if err != nil {
		log.Println("no .env file found, using environment only")
	}
	username := GetFromEnv("DB_USERNAME")
	password := GetFromEnv("DB_PASSWORD")
	host := GetFromEnv("DB_HOST")
	port := GetFromEnv("DB_PORT")
	dbname := GetFromEnv("DB_NAME")
	psql := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s?sslmode=require&channel_binding=require", username, password, host, port, dbname)
	db, err := gorm.Open(postgres.Open(psql), &gorm.Config{})
	if err != nil {
		panic("failed to connect database")
	}
	return db
}

func GetFromEnv(key string) string {
	return os.Getenv(key)
}

func GenerateToken(user *models.User) (string, time.Time, error) {
	now := time.Now()
	ttl, err := strconv.Atoi(GetFromEnv("TTL_ACCESS_TOKEN"))
	if err != nil {
		return "", time.Time{}, err
	}
	exp := now.Add(time.Duration(ttl) * time.Minute)

	claims := &Claims{
		UserID:   user.ID,
		Username: user.Username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	secretKey := GetFromEnv("JWT_SECRET_KEY")
	if secretKey == "" {
		return "", time.Time{}, errors.New("JWT_SECRET_KEY is not set in environment variables")
	}
	signed, err := token.SignedString([]byte(secretKey))
	return signed, exp, err
}

func ParseToken(tokenStr string) (*Claims, error) {
	claims := &Claims{}

	token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(GetFromEnv("JWT_SECRET_KEY")), nil
	})

	if err != nil {
		return nil, err
	}

	if !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	return claims, nil
}

func RunDailyJob(ctx context.Context) error {
	db := GetDB().WithContext(ctx)

	var users []models.User
	if err := db.Find(&users).Error; err != nil {
		return err
	}

	for _, user := range users {
		for _, activity := range models.ActivityNames {
			var activityModel models.Activity

			if err := db.
				Where("user_id = ? AND name = ? AND activity_date = CURRENT_DATE", user.ID, activity).
				Attrs(models.Activity{
					UserID:        user.ID,
					Name:          activity,
					DurationHours: 0,
				}).
				FirstOrCreate(&activityModel).Error; err != nil {
				return err
			}
		}
	}

	return nil
}
