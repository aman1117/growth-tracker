package utils

import (
	"errors"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"fmt"

	"github.com/aman1117/backend/models"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Claims struct {
	UserID   uint   `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

var (
	db   *gorm.DB
	once sync.Once
)

func InitDB() {
	err := godotenv.Load()
	if err != nil {
		log.Println("no .env file found, using environment only")
	}
}

func GetDB() *gorm.DB {
	once.Do(func() {
		username := GetFromEnv("DB_USERNAME")
		password := GetFromEnv("DB_PASSWORD")
		host := GetFromEnv("DB_HOST")
		port := GetFromEnv("DB_PORT")
		dbname := GetFromEnv("DB_NAME")
		psql := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s?sslmode=require", username, password, host, port, dbname)

		var err error
		db, err = gorm.Open(postgres.Open(psql), &gorm.Config{
			PrepareStmt: true, // Cache prepared statements for better performance
			Logger: logger.Default.LogMode(logger.Info), // Log ALL SQL queries
		})
		if err != nil {
			panic("failed to connect database")
		}

		// Configure connection pool
		sqlDB, err := db.DB()
		if err != nil {
			panic("failed to get underlying sql.DB")
		}

		// Connection pool settings for better performance
		sqlDB.SetMaxIdleConns(10)                  // Keep 10 idle connections ready
		sqlDB.SetMaxOpenConns(100)                 // Max 100 concurrent connections
		sqlDB.SetConnMaxLifetime(time.Hour)        // Recycle connections after 1 hour
		sqlDB.SetConnMaxIdleTime(10 * time.Minute) // Close idle connections after 10 min

		log.Println("Database connection pool initialized")
	})
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
