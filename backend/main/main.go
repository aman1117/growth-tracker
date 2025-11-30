package main

import (
	"fmt"
	"log"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/services"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

func main() {

	db := utils.GetDB()
	if err := db.Error; err != nil {
		log.Fatalf("DB connection failed: %v", err)
	}

	if err := db.AutoMigrate(&models.User{}, &models.Activity{}); err != nil {
		log.Fatalf("AutoMigrate failed: %v", err)
	}
	fmt.Println("DB Migrations Successful")

	app := fiber.New()
	app.Use(cors.New(cors.Config{
		AllowOrigins:     "*",   // allow all origins
		AllowMethods:     "*",   // allow all HTTP methods
		AllowHeaders:     "*",   // allow all headers
		ExposeHeaders:    "*",   // optional: expose all headers
		AllowCredentials: false, // set true only if you really need cookies/auth headers
	}))

	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API is running...")
	})
	app.Post("/register", services.RegisterHandler)
	app.Post("/login", services.LoginHandler)
	app.Post("/users", services.AuthMiddleware, services.GetUsersHandler)

	app.Post("/create-activity", services.AuthMiddleware, services.CreateActivityHandler)
	app.Post("/get-activities", services.AuthMiddleware, services.GetActivityHandler)

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
