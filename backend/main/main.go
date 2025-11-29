package main

import (
	"fmt"
	"log"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/services"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
)

func main() {

	db := utils.GetDB()
	if err := db.Error; err != nil {
		log.Fatalf("DB connection failed: %v", err)
	}

	if err := db.AutoMigrate(&models.User{}); err != nil {
		log.Fatalf("AutoMigrate failed: %v", err)
	}
	fmt.Println("DB Migrations Successful")

	app := fiber.New()

	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API is running...")
	})
	app.Post("/register", services.RegisterHandler)
	app.Post("/login", services.LoginHandler)

	port := utils.GetFromEnv("PORT")
	if port == "" {
		port = "8000"
	}
	addr := "0.0.0.0:" + port
	if err := app.Listen(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	} else {
		fmt.Println("Server is running at http://localhost:" + port)
	}
}
